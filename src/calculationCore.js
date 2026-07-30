/**
 * LCOH calculator core (VDI 2067 & 4645, no DOM).
 */

const HEAT_VALUE_ELECTRICITY_KCAL_PER_KWH = 860.4;

/** Default per-kW capex for synthesized OTA heat-pump scheme (matches browser Ind HP A). */
export const DEFAULT_HP_CAPEX_PER_KW = 2200;
export const DEFAULT_HP_OPEX_FIXED_RATE = 0.02;

function isFiniteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n);
}

function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') {
      return obj[k];
    }
  }
  return undefined;
}

function pctToRate(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return NaN;
  return n > 1 ? n / 100 : n;
}

/**
 * Capital recovery factor (annuity factor).
 * @param {number} discountRate — decimal, e.g. 0.05
 * @param {number} lifespan — years
 */
export function calculateCrf(discountRate, lifespan) {
  if (lifespan <= 0) return NaN;
  if (discountRate === 0) return 1 / lifespan;
  const f = Math.pow(1 + discountRate, lifespan);
  return (discountRate * f) / (f - 1);
}

/**
 * @param {object} scheme
 * @param {number} peakHeatLoadKw
 * @param {number} annualHeatDemandKwh
 * @param {number} crf
 * @param {number} pricePerKwhElectricity
 * @param {{ gas?: number, biomass?: number }} fuelPricesPerKwh
 */
export function calculateSchemeLcoh(scheme, peakHeatLoadKw, annualHeatDemandKwh, crf, pricePerKwhElectricity, fuelPricesPerKwh = {}) {
  const type = scheme.type || 'heat_pump';
  const capCostPerKw = Number(scheme.capCostPerKw ?? scheme.capCost ?? scheme.cap_cost);
  const opexFixedRate = pctToRate(scheme.opexFixedRate ?? scheme.opex_fixed_rate ?? 0.02);
  const totalCapCost = capCostPerKw * peakHeatLoadKw;

  let performance = NaN;
  if (type === 'heat_pump') {
    performance = Number(scheme.spf ?? scheme.estimatedCop ?? scheme.hpCop);
  } else {
    performance = pctToRate(scheme.efficiency ?? scheme.thermalEfficiency ?? scheme.eff);
  }

  const annualCapCost = totalCapCost * crf;
  const annualOpexCapTied = totalCapCost * opexFixedRate;

  let pricePerKwhFuel = pricePerKwhElectricity;
  if (type === 'gas') {
    pricePerKwhFuel = fuelPricesPerKwh.gas ?? pricePerKwhElectricity;
  } else if (type === 'biomass') {
    pricePerKwhFuel = fuelPricesPerKwh.biomass ?? pricePerKwhElectricity;
  }

  const annualOpexOpTied = (pricePerKwhFuel / performance) * annualHeatDemandKwh;
  const annualCost = annualCapCost + annualOpexCapTied + annualOpexOpTied;
  const lcoh = annualCost / annualHeatDemandKwh;

  return {
    id: scheme.id || scheme.name || type,
    name: scheme.name || scheme.id || type,
    type,
    lcoh,
    annualCost,
    annualCapCost,
    annualOpexCapTied,
    annualOpexOpTied,
    totalCapCost,
    peakHeatLoadKw,
    performance,
  };
}

/**
 * Build scheme list from raw inputs (explicit schemes or OTA default HP).
 * @param {Record<string, unknown>} raw
 */
export function resolveSchemes(raw, peakHeatLoadKw, assumptions) {
  const schemes = [];
  const missingInputs = [];

  if (Array.isArray(raw.schemes) && raw.schemes.length) {
    for (const s of raw.schemes) {
      const cap = pick(s, 'capCostPerKw', 'capCost', 'cap_cost');
      const perf = pick(s, 'spf', 'estimatedCop', 'hpCop', 'efficiency', 'eff');
      const type = s.type || (pick(s, 'spf', 'estimatedCop') ? 'heat_pump' : 'boiler');

      if (!isFiniteNumber(cap)) {
        if (raw.assumeDefaultCapex === true && type === 'heat_pump') {
          schemes.push({
            ...s,
            type: 'heat_pump',
            capCostPerKw: DEFAULT_HP_CAPEX_PER_KW,
            opexFixedRate: s.opexFixedRate ?? DEFAULT_HP_OPEX_FIXED_RATE,
          });
          assumptions.push(
            `Scheme "${s.name || s.id || 'hp'}": capCostPerKw defaulted to ${DEFAULT_HP_CAPEX_PER_KW} (assumeDefaultCapex=true).`,
          );
        } else {
          missingInputs.push(`schemes[].capCost (${s.name || s.id || '?'})`);
        }
      } else if (!isFiniteNumber(perf)) {
        missingInputs.push(`schemes[].spf|efficiency (${s.name || s.id || '?'})`);
      } else {
        schemes.push(s);
      }
    }
    return { schemes, missingInputs };
  }

  const spf = pick(raw, 'spf', 'estimatedCop', 'hpCop');
  const capExplicit = pick(raw, 'capCostPerKw', 'capCost', 'cap_cost');

  if (isFiniteNumber(spf)) {
    if (isFiniteNumber(capExplicit)) {
      schemes.push({
        id: 'heat_pump',
        name: 'Industrial heat pump',
        type: 'heat_pump',
        capCostPerKw: Number(capExplicit),
        opexFixedRate: raw.opexFixedRate ?? DEFAULT_HP_OPEX_FIXED_RATE,
        spf: Number(spf),
      });
    } else if (raw.assumeDefaultCapex === true) {
      schemes.push({
        id: 'heat_pump',
        name: 'Industrial heat pump (OTA default)',
        type: 'heat_pump',
        capCostPerKw: DEFAULT_HP_CAPEX_PER_KW,
        opexFixedRate: raw.opexFixedRate ?? DEFAULT_HP_OPEX_FIXED_RATE,
        spf: Number(spf),
      });
      assumptions.push(
        `Default HP scheme: capCostPerKw=${DEFAULT_HP_CAPEX_PER_KW}, opexFixedRate=${DEFAULT_HP_OPEX_FIXED_RATE * 100}% (assumeDefaultCapex=true).`,
      );
    } else {
      missingInputs.push('capCost');
    }
  }

  return { schemes, missingInputs };
}

/**
 * @param {Record<string, unknown>} raw
 */
export function calculateLcoh(raw) {
  const assumptions = [
    'LCOH per VDI 2067: annual cost = CRF×capex + opex_cap + opex_op; LCOH = annual cost / annual heat demand.',
    'Peak heat load = annualHeatDemand / annualOperatingHours.',
    'Electricity fuel price used directly (CNY/kWh); gas/biomass converted via heat values when provided.',
  ];
  const warnings = [];
  const missingInputs = [];

  const annualHeatDirect = pick(raw, 'annualHeatDemand', 'qDemandTotal');
  const heatLoadKw = pick(raw, 'heatLoadKw', 'peakHeatLoadKw');
  const annualHoursDirect = pick(raw, 'annualOperatingHours', 'annualHours');
  const operationDays = pick(raw, 'operationDays');
  const dailyHours = pick(raw, 'dailyHours');

  let annualHeatDemand = isFiniteNumber(annualHeatDirect) ? Number(annualHeatDirect) : NaN;
  let annualHours = NaN;

  if (isFiniteNumber(annualHoursDirect)) {
    annualHours = Number(annualHoursDirect);
  } else if (isFiniteNumber(operationDays) && isFiniteNumber(dailyHours)) {
    annualHours = Number(operationDays) * Number(dailyHours);
  }

  if (!isFiniteNumber(annualHeatDemand) && isFiniteNumber(heatLoadKw) && isFiniteNumber(annualHours)) {
    annualHeatDemand = Number(heatLoadKw) * annualHours;
    assumptions.push('annualHeatDemand synthesized as heatLoadKw × annualOperatingHours.');
  }

  if (!isFiniteNumber(annualHeatDemand)) missingInputs.push('annualHeatDemand');
  if (!isFiniteNumber(annualHours)) {
    missingInputs.push('operationDays');
    missingInputs.push('dailyHours');
  }

  const lifespan = pick(raw, 'lifespan', 'projectLifespan');
  const discountRateRaw = pick(raw, 'discountRate', 'discount_rate');
  const electricityPrice = pick(raw, 'electricityPrice', 'electricity_price', 'price');

  if (!isFiniteNumber(lifespan)) missingInputs.push('lifespan');
  if (!isFiniteNumber(discountRateRaw)) missingInputs.push('discountRate');
  if (!isFiniteNumber(electricityPrice)) missingInputs.push('electricityPrice');

  const schemeAssumptions = [];
  const { schemes, missingInputs: schemeMissing } = resolveSchemes(raw, 0, schemeAssumptions);
  missingInputs.push(...schemeMissing);

  if (!schemes.length && !schemeMissing.length) {
    missingInputs.push('schemes');
  }

  if (missingInputs.length) {
    return {
      ok: false,
      results: null,
      missingInputs: [...new Set(missingInputs)],
      warnings,
      assumptions: [
        ...assumptions,
        'Missing inputs return missingInputs; capex is not invented unless assumeDefaultCapex=true.',
      ],
    };
  }

  const discountRate = pctToRate(Number(discountRateRaw));
  const crf = calculateCrf(discountRate, Number(lifespan));
  const peakHeatLoad = annualHeatDemand / annualHours;

  if (annualHeatDemand <= 0 || annualHours <= 0 || peakHeatLoad <= 0) {
    return {
      ok: false,
      results: null,
      missingInputs: [],
      warnings: ['annualHeatDemand and annual operating hours must be > 0.'],
      assumptions,
      message: 'annualHeatDemand and operating hours must be > 0',
    };
  }

  const kCalToKwh = 1 / HEAT_VALUE_ELECTRICITY_KCAL_PER_KWH;
  const pricePerKwhElectricity = Number(electricityPrice);

  const gasPrice = pick(raw, 'gasPrice');
  const heatValueGas = pick(raw, 'heatValueGas');
  let pricePerKwhGas = 0;
  if (isFiniteNumber(gasPrice) && isFiniteNumber(heatValueGas) && Number(heatValueGas) > 0) {
    pricePerKwhGas = Number(gasPrice) / (Number(heatValueGas) * kCalToKwh);
  }

  const biomassPrice = pick(raw, 'biomassPrice');
  const heatValueBiomass = pick(raw, 'heatValueBiomass');
  let pricePerKwhBiomass = 0;
  if (isFiniteNumber(biomassPrice) && isFiniteNumber(heatValueBiomass) && Number(heatValueBiomass) > 0) {
    pricePerKwhBiomass = Number(biomassPrice) / (Number(heatValueBiomass) * kCalToKwh);
  }

  const fuelPrices = { gas: pricePerKwhGas, biomass: pricePerKwhBiomass };
  const results = schemes.map((s) =>
    calculateSchemeLcoh(s, peakHeatLoad, annualHeatDemand, crf, pricePerKwhElectricity, fuelPrices),
  );

  results.sort((a, b) => a.lcoh - b.lcoh);

  return {
    ok: true,
    results: {
      crf,
      peakHeatLoadKw: peakHeatLoad,
      annualHeatDemandKwh: annualHeatDemand,
      annualOperatingHours: annualHours,
      discountRate,
      lifespan: Number(lifespan),
      schemes: results,
      bestScheme: results[0]?.name ?? null,
      lowestLcoh: results[0]?.lcoh ?? null,
    },
    missingInputs: [],
    warnings,
    assumptions: [...assumptions, ...schemeAssumptions],
  };
}
