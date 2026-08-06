const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Shop = require('../models/Shop');
const router = express.Router();

const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID || 'mock',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'mock',
    callbackURL: process.env.GOOGLE_CALLBACK_URL || '/api/auth/google/callback'
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.emails[0].value;

      let user = await User.findOne({ googleId: profile.id });
      if (!user) {
        let role = 'student';
        const adminEmails = (process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL || '')
          .split(',')
          .map(e => e.trim().toLowerCase())
          .filter(Boolean);
        if (adminEmails.includes(email.toLowerCase())) {
          role = 'admin';
        }
        user = await User.create({
          googleId: profile.id,
          name: profile.displayName,
          email,
          avatar: profile.photos[0]?.value,
          role
        });
      } else {
        const adminEmails = (process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL || '')
          .split(',')
          .map(e => e.trim().toLowerCase())
          .filter(Boolean);
        const shouldBeAdmin = adminEmails.includes(user.email.toLowerCase());
        if (shouldBeAdmin && user.role !== 'admin') {
          user.role = 'admin';
          await user.save();
        }
      }
      return done(null, user);
    } catch (err) {
      return done(err, null);
    }
  }
));

router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

router.get('/google/callback', (req, res, next) => {
  passport.authenticate('google', { session: false }, (err, user, info) => {
    if (err || !user) {
      const message = info?.message || 'Login failed. Please try again.';
      return res.redirect(`${process.env.FRONTEND_URL}/?loginError=${encodeURIComponent(message)}`);
    }
    req.user = user;
    next();
  })(req, res, next);
}, asyncHandler(async (req, res) => {
  const token = jwt.sign({ id: req.user._id }, process.env.JWT_SECRET || 'secret', { expiresIn: '7d' });
  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  // Admins and shop owners have their own dashboards and never go through student onboarding.
  if (req.user.role === 'admin') {
    return res.redirect(`${process.env.FRONTEND_URL}/admin#token=${token}`);
  }
  const ownsShop = await Shop.findOne({ ownerEmail: req.user.email.toLowerCase() });
  if (ownsShop) {
    return res.redirect(`${process.env.FRONTEND_URL}/shop-owner#token=${token}`);
  }
  // Regular students complete their profile first.
  if (!req.user.isOnboarded) {
    return res.redirect(`${process.env.FRONTEND_URL}/onboarding#token=${token}`);
  }
  res.redirect(`${process.env.FRONTEND_URL}/home#token=${token}`);
}));

router.post('/logout', (req, res) => {
  res.clearCookie('token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  });
  res.json({ message: 'Logged out successfully' });
});

router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const ownsShop = await Shop.findOne({ ownerEmail: req.user.email.toLowerCase() });
  const userObj = req.user.toObject();
  userObj.isShopOwner = !!ownsShop;
  res.json(userObj);
}));

module.exports = router;
