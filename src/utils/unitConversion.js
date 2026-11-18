// Unit conversion helper used when deducting recipe ingredient usage from
// stock. Each known unit is mapped to a canonical base unit (g for weight,
// ml for volume, pcs / portion / unit for counts) and a factor to convert
// to that base. Conversion is only possible between two units sharing the
// same base.

const normalize = (u) => (u ?? '').toString().trim().toLowerCase();

const CONVERSIONS = {
  // ── Weight ──────────────────────────────────────────────
  kg: { base: 'g', factor: 1000 },
  kgs: { base: 'g', factor: 1000 },
  kilogram: { base: 'g', factor: 1000 },
  kilograms: { base: 'g', factor: 1000 },
  g: { base: 'g', factor: 1 },
  gm: { base: 'g', factor: 1 },
  gms: { base: 'g', factor: 1 },
  gram: { base: 'g', factor: 1 },
  grams: { base: 'g', factor: 1 },
  mg: { base: 'g', factor: 0.001 },
  milligram: { base: 'g', factor: 0.001 },
  milligrams: { base: 'g', factor: 0.001 },
  lb: { base: 'g', factor: 453.59237 },
  lbs: { base: 'g', factor: 453.59237 },
  pound: { base: 'g', factor: 453.59237 },
  pounds: { base: 'g', factor: 453.59237 },
  oz: { base: 'g', factor: 28.349523125 },
  ounce: { base: 'g', factor: 28.349523125 },
  ounces: { base: 'g', factor: 28.349523125 },

  // ── Volume ──────────────────────────────────────────────
  l: { base: 'ml', factor: 1000 },
  lt: { base: 'ml', factor: 1000 },
  ltr: { base: 'ml', factor: 1000 },
  liter: { base: 'ml', factor: 1000 },
  liters: { base: 'ml', factor: 1000 },
  litre: { base: 'ml', factor: 1000 },
  litres: { base: 'ml', factor: 1000 },
  ml: { base: 'ml', factor: 1 },
  milliliter: { base: 'ml', factor: 1 },
  milliliters: { base: 'ml', factor: 1 },
  millilitre: { base: 'ml', factor: 1 },
  millilitres: { base: 'ml', factor: 1 },
  cup: { base: 'ml', factor: 236.5882365 },
  cups: { base: 'ml', factor: 236.5882365 },
  tbsp: { base: 'ml', factor: 14.78676478125 },
  tablespoon: { base: 'ml', factor: 14.78676478125 },
  tablespoons: { base: 'ml', factor: 14.78676478125 },
  tsp: { base: 'ml', factor: 4.92892159375 },
  teaspoon: { base: 'ml', factor: 4.92892159375 },
  teaspoons: { base: 'ml', factor: 4.92892159375 },
  'fl oz': { base: 'ml', factor: 29.5735295625 },

  // ── Fabric length ───────────────────────────────────────
  m: { base: 'cm', factor: 100 },
  meter: { base: 'cm', factor: 100 },
  meters: { base: 'cm', factor: 100 },
  metre: { base: 'cm', factor: 100 },
  metres: { base: 'cm', factor: 100 },
  cm: { base: 'cm', factor: 1 },
  centimeter: { base: 'cm', factor: 1 },
  centimeters: { base: 'cm', factor: 1 },
  centimetre: { base: 'cm', factor: 1 },
  centimetres: { base: 'cm', factor: 1 },
  yard: { base: 'cm', factor: 91.44 },
  yards: { base: 'cm', factor: 91.44 },
  yd: { base: 'cm', factor: 91.44 },
  ft: { base: 'cm', factor: 30.48 },
  foot: { base: 'cm', factor: 30.48 },
  feet: { base: 'cm', factor: 30.48 },
  in: { base: 'cm', factor: 2.54 },
  inch: { base: 'cm', factor: 2.54 },
  inches: { base: 'cm', factor: 2.54 },

  // ── Count-like ──────────────────────────────────────────
  pcs: { base: 'pcs', factor: 1 },
  pc: { base: 'pcs', factor: 1 },
  piece: { base: 'pcs', factor: 1 },
  pieces: { base: 'pcs', factor: 1 },
  each: { base: 'pcs', factor: 1 },
  ea: { base: 'pcs', factor: 1 },
  unit: { base: 'pcs', factor: 1 },
  units: { base: 'pcs', factor: 1 },
  portion: { base: 'portion', factor: 1 },
  portions: { base: 'portion', factor: 1 },
  serving: { base: 'portion', factor: 1 },
  servings: { base: 'portion', factor: 1 },
};

/**
 * Convert a quantity from `fromUnit` to `toUnit`.
 * Returns { qty, converted }.
 *   • converted = true  → quantity was converted (including same-unit case)
 *   • converted = false → units are incompatible; caller should fall back
 *                         to the original quantity.
 */
export const convertQty = (qty, fromUnit, toUnit) => {
  const numQty = Number(qty);
  if (!Number.isFinite(numQty)) return { qty: 0, converted: false };

  const from = normalize(fromUnit);
  const to = normalize(toUnit);

  if (!from || !to || from === to) {
    return { qty: numQty, converted: true };
  }

  const fromDef = CONVERSIONS[from];
  const toDef = CONVERSIONS[to];

  if (!fromDef || !toDef || fromDef.base !== toDef.base) {
    return { qty: numQty, converted: false };
  }

  const inBase = numQty * fromDef.factor;
  const result = inBase / toDef.factor;
  return { qty: result, converted: true };
};

export default { convertQty };
