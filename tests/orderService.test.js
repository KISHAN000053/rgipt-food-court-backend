const test = require('node:test');
const assert = require('node:assert/strict');
const {
  priceCart,
  resolveLinePrice,
  validateStatusTransition,
} = require('../services/orderService');

test('priceCart rejects an empty cart', async () => {
  const result = await priceCart({ user: {}, items: [], orderType: 'takeaway' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});

test('priceCart rejects too many cart lines before database access', async () => {
  const items = Array.from({ length: 51 }, () => ({
    menuItemId: '0123456789abcdef01234567',
    quantity: 1,
  }));
  const result = await priceCart({ user: {}, items, orderType: 'takeaway' });
  assert.equal(result.ok, false);
  assert.match(result.message, /at most 50/);
});

test('priceCart rejects invalid menu IDs and quantities', async () => {
  const validId = '0123456789abcdef01234567';
  for (const item of [
    { menuItemId: 'not-an-object-id', quantity: 1 },
    { menuItemId: validId, quantity: 0 },
    { menuItemId: validId, quantity: -1 },
    { menuItemId: validId, quantity: 1.5 },
    { menuItemId: validId, quantity: 21 },
  ]) {
    const result = await priceCart({ user: {}, items: [item], orderType: 'takeaway' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
  }
});

test('priceCart rejects unsupported order types', async () => {
  const result = await priceCart({
    user: {},
    items: [{ menuItemId: '0123456789abcdef01234567', quantity: 1 }],
    orderType: 'delivery-to-anywhere',
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /Invalid order type/);
});

test('resolveLinePrice uses the base price for a non-variant item', () => {
  const result = resolveLinePrice({ hasVariants: false, price: 42 }, undefined);
  assert.deepEqual(result, { ok: true, price: 42, variantName: undefined });
});

test('resolveLinePrice requires a valid variant when variants are enabled', () => {
  const item = {
    name: 'Tea',
    hasVariants: true,
    variants: { id: (id) => id === 'small' ? { price: 20, name: 'Small' } : null },
  };
  assert.deepEqual(resolveLinePrice(item, 'small'), {
    ok: true, price: 20, variantName: 'Small',
  });
  assert.equal(resolveLinePrice(item, 'missing').ok, false);
});

test('order state machine rejects invalid transitions', () => {
  const result = validateStatusTransition({
    order: { status: 'completed', orderType: 'takeaway' },
    newStatus: 'cancelled',
  });
  assert.equal(result.ok, false);
});

test('takeaway orders require the correct pickup PIN before completion', () => {
  const order = { status: 'delivery_initiated', orderType: 'takeaway', pickupPin: '1234' };
  assert.equal(validateStatusTransition({ order, newStatus: 'completed', providedPin: '0000' }).ok, false);
  assert.equal(validateStatusTransition({ order, newStatus: 'completed', providedPin: '1234' }).ok, true);
});
