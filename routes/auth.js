const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Shop = require('../models/Shop');
const router = express.Router();

const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const getAdminEmails = () => (process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL || '')
  .split(',')
  .map(email => email.trim().toLowerCase())
  .filter(Boolean);

const getAllowedEmailDomains = () => {
  const configured = process.env.ALLOWED_EMAIL_DOMAINS;
  // Preserve existing RGIPT behavior until a deployment explicitly configures its domain(s).
  const domains = (configured || 'rgipt.ac.in')
    .split(',')
    .map(domain => domain.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
  return domains;
};

const isAllowedEmail = async (email) => {
  const lower = String(email || '').trim().toLowerCase();
  const domain = lower.split('@').pop();
  const allowedDomains = getAllowedEmailDomains();
  if (lower.includes('@') && allowedDomains.includes(domain)) return true;

  if (getAdminEmails().includes(lower)) return true;
  const ownsShop = await Shop.findOne({ ownerEmail: lower });
  return !!ownsShop;
};

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID || 'mock',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'mock',
    callbackURL: process.env.GOOGLE_CALLBACK_URL || '/api/auth/google/callback'
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.emails?.[0]?.value;
      if (!email) {
        return done(null, false, { message: 'Google did not return an email address for this account.' });
      }

      const allowed = await isAllowedEmail(email);
      if (!allowed) {
        return done(null, false, { message: 'This email is not allowed to sign in to this campus food court.' });
      }

      const normalizedEmail = email.trim().toLowerCase();
      let user = await User.findOne({ googleId: profile.id });
      if (!user) {
        const role = getAdminEmails().includes(normalizedEmail) ? 'admin' : 'student';
        user = await User.create({
          googleId: profile.id,
          name: profile.displayName,
          email: normalizedEmail,
          avatar: profile.photos?.[0]?.value,
          role
        });
      } else {
        const shouldBeAdmin = getAdminEmails().includes(user.email.toLowerCase());
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
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET must be configured before issuing authentication tokens.');
  }
  if (!process.env.FRONTEND_URL) {
    throw new Error('FRONTEND_URL must be configured before completing authentication.');
  }

  const token = jwt.sign({ id: req.user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
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
