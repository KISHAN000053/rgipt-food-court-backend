// An order placed with Razorpay isn't real until it's actually paid — the student
// may have abandoned the checkout modal. This filter, merged into a query, hides
// those unpaid orders from shops, admin lists, and financial totals. Cash orders
// are unaffected (payment happens on delivery, so 'pending' is expected for them).
const CONFIRMED_PAYMENT_FILTER = {
  $or: [
    { paymentMethod: { $ne: 'razorpay' } },
    { paymentStatus: 'paid' },
  ],
};

module.exports = { CONFIRMED_PAYMENT_FILTER };
