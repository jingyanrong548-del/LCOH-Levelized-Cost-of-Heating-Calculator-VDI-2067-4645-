/**
 * Smoke test for LCOH /calculate.
 * Run: npm run test:calculate-api
 */
import assert from 'node:assert/strict';
import { handleCalculateBody } from './calculate-api.mjs';

const missing = handleCalculateBody({ inputs: {}, locale: 'zh' });
assert.equal(missing.ok, false);
assert.ok((missing.missingInputs || []).length > 0);

const needCapex = handleCalculateBody({
  inputs: {
    heatLoadKw: 500,
    annualOperatingHours: 4000,
    lifespan: 20,
    discountRate: 5,
    electricityPrice: 0.7,
    estimatedCop: 3.5,
  },
});
assert.equal(needCapex.ok, false);
assert.ok(needCapex.missingInputs.includes('capCost'));

const ok = handleCalculateBody({
  locale: 'zh',
  inputs: {
    heatLoadKw: 500,
    annualOperatingHours: 4000,
    lifespan: 20,
    discountRate: 5,
    electricityPrice: 0.7,
    estimatedCop: 3.5,
    assumeDefaultCapex: true,
  },
});
assert.equal(ok.ok, true, ok.message || JSON.stringify(ok));
assert.ok(Number.isFinite(ok.results.lowestLcoh));
assert.match(ok.version, /^lcoh-calculator-/);

console.log('test:calculate-api OK', {
  version: ok.version,
  lowestLcoh: ok.results.lowestLcoh,
  bestScheme: ok.results.bestScheme,
});
