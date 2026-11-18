import AssetCategory from '../models/AssetCategory.js';
import ChartOfAccounts from '../models/ChartOfAccounts.js';
import { getTenantStore } from '../db/tenantContext.js';
import logger from '../utils/logger.js';

const ACCOUNT_DEFINITIONS = [
  { key: 'land', code: '1600', name: 'Land', type: 'asset', subType: 'fixedAsset', normalBalance: 'debit' },
  { key: 'buildings', code: '1610', name: 'Buildings and Site Improvements', type: 'asset', subType: 'fixedAsset', normalBalance: 'debit' },
  { key: 'buildingsAccum', code: '1611', name: 'Accumulated Depreciation — Buildings and Site Improvements', type: 'asset', subType: 'accumulatedDepreciation', normalBalance: 'credit' },
  { key: 'leasehold', code: '1620', name: 'Leasehold Improvements and Renovations', type: 'asset', subType: 'fixedAsset', normalBalance: 'debit' },
  { key: 'leaseholdAccum', code: '1621', name: 'Accumulated Depreciation — Leasehold Improvements', type: 'asset', subType: 'accumulatedDepreciation', normalBalance: 'credit' },
  { key: 'kitchen', code: '1630', name: 'Kitchen Machinery and Equipment', type: 'asset', subType: 'fixedAsset', normalBalance: 'debit' },
  { key: 'kitchenAccum', code: '1631', name: 'Accumulated Depreciation — Kitchen Machinery and Equipment', type: 'asset', subType: 'accumulatedDepreciation', normalBalance: 'credit' },
  { key: 'furniture', code: '1640', name: 'Furniture, Fixtures and Smallwares', type: 'asset', subType: 'fixedAsset', normalBalance: 'debit' },
  { key: 'furnitureAccum', code: '1641', name: 'Accumulated Depreciation — Furniture and Fixtures', type: 'asset', subType: 'accumulatedDepreciation', normalBalance: 'credit' },
  { key: 'technology', code: '1650', name: 'Computers, POS and Communication Equipment', type: 'asset', subType: 'fixedAsset', normalBalance: 'debit' },
  { key: 'technologyAccum', code: '1651', name: 'Accumulated Depreciation — Computers and POS Equipment', type: 'asset', subType: 'accumulatedDepreciation', normalBalance: 'credit' },
  { key: 'vehicles', code: '1660', name: 'Vehicles and Delivery Equipment', type: 'asset', subType: 'fixedAsset', normalBalance: 'debit' },
  { key: 'vehiclesAccum', code: '1661', name: 'Accumulated Depreciation — Vehicles and Delivery Equipment', type: 'asset', subType: 'accumulatedDepreciation', normalBalance: 'credit' },
  { key: 'systems', code: '1670', name: 'Safety, Security and Building Systems', type: 'asset', subType: 'fixedAsset', normalBalance: 'debit' },
  { key: 'systemsAccum', code: '1671', name: 'Accumulated Depreciation — Safety and Building Systems', type: 'asset', subType: 'accumulatedDepreciation', normalBalance: 'credit' },
  { key: 'tableware', code: '1680', name: 'Crockery, Cutlery, Glassware and Reusable Linens', type: 'asset', subType: 'fixedAsset', normalBalance: 'debit' },
  { key: 'tablewareAccum', code: '1681', name: 'Accumulated Depreciation — Tableware and Reusable Linens', type: 'asset', subType: 'accumulatedDepreciation', normalBalance: 'credit' },
  { key: 'other', code: '1690', name: 'Other Fixed Assets', type: 'asset', subType: 'fixedAsset', normalBalance: 'debit' },
  { key: 'otherAccum', code: '1691', name: 'Accumulated Depreciation — Other Fixed Assets', type: 'asset', subType: 'accumulatedDepreciation', normalBalance: 'credit' },
  { key: 'buildingsDep', code: '6200', name: 'Depreciation Expense — Buildings and Site Improvements', type: 'expense', subType: 'operatingExpense', normalBalance: 'debit' },
  { key: 'leaseholdDep', code: '6201', name: 'Depreciation Expense — Leasehold Improvements', type: 'expense', subType: 'operatingExpense', normalBalance: 'debit' },
  { key: 'kitchenDep', code: '6202', name: 'Depreciation Expense — Kitchen Machinery and Equipment', type: 'expense', subType: 'operatingExpense', normalBalance: 'debit' },
  { key: 'furnitureDep', code: '6203', name: 'Depreciation Expense — Furniture and Fixtures', type: 'expense', subType: 'operatingExpense', normalBalance: 'debit' },
  { key: 'technologyDep', code: '6204', name: 'Depreciation Expense — Computers and POS Equipment', type: 'expense', subType: 'operatingExpense', normalBalance: 'debit' },
  { key: 'vehiclesDep', code: '6205', name: 'Depreciation Expense — Vehicles and Delivery Equipment', type: 'expense', subType: 'operatingExpense', normalBalance: 'debit' },
  { key: 'systemsDep', code: '6206', name: 'Depreciation Expense — Safety and Building Systems', type: 'expense', subType: 'operatingExpense', normalBalance: 'debit' },
  { key: 'tablewareDep', code: '6207', name: 'Depreciation Expense — Tableware and Reusable Linens', type: 'expense', subType: 'operatingExpense', normalBalance: 'debit' },
  { key: 'otherDep', code: '6208', name: 'Depreciation Expense — Other Fixed Assets', type: 'expense', subType: 'operatingExpense', normalBalance: 'debit' },
  { key: 'writeOff', code: '6210', name: 'Loss on Asset Disposal and Write-off', type: 'expense', subType: 'operatingExpense', normalBalance: 'debit' },
  { key: 'gain', code: '4210', name: 'Gain on Disposal of Assets', type: 'revenue', subType: 'otherIncome', normalBalance: 'credit' },
];

const GROUPS = {
  land: { asset: 'land' },
  buildings: {
    asset: 'buildings',
    accumulatedDepreciation: 'buildingsAccum',
    depreciationExpense: 'buildingsDep',
  },
  leasehold: {
    asset: 'leasehold',
    accumulatedDepreciation: 'leaseholdAccum',
    depreciationExpense: 'leaseholdDep',
  },
  kitchen: {
    asset: 'kitchen',
    accumulatedDepreciation: 'kitchenAccum',
    depreciationExpense: 'kitchenDep',
  },
  furniture: {
    asset: 'furniture',
    accumulatedDepreciation: 'furnitureAccum',
    depreciationExpense: 'furnitureDep',
  },
  technology: {
    asset: 'technology',
    accumulatedDepreciation: 'technologyAccum',
    depreciationExpense: 'technologyDep',
  },
  vehicles: {
    asset: 'vehicles',
    accumulatedDepreciation: 'vehiclesAccum',
    depreciationExpense: 'vehiclesDep',
  },
  systems: {
    asset: 'systems',
    accumulatedDepreciation: 'systemsAccum',
    depreciationExpense: 'systemsDep',
  },
  tableware: {
    asset: 'tableware',
    accumulatedDepreciation: 'tablewareAccum',
    depreciationExpense: 'tablewareDep',
  },
  other: {
    asset: 'other',
    accumulatedDepreciation: 'otherAccum',
    depreciationExpense: 'otherDep',
  },
};

const category = ({
  code,
  name,
  group,
  description,
  trackingMode = 'serialized',
  defaultUnit = 'unit',
  life = 60,
  residual = 0,
  frequency = 90,
  depreciationMethod = 'straightLine',
  threshold = 0,
}) => ({
  code,
  name,
  group,
  description,
  trackingMode,
  defaultUnit,
  defaultUsefulLifeMonths: life,
  defaultResidualValuePercent: residual,
  depreciationMethod,
  auditFrequencyDays: frequency,
  capitalisationThreshold: threshold,
});

const CATEGORY_DEFINITIONS = [
  category({ code: 'LAND', name: 'Land', group: 'land', description: 'Owned restaurant sites, plots and non-depreciating land.', life: 240, residual: 100, frequency: 365, depreciationMethod: 'none' }),
  category({ code: 'SITE-IMP', name: 'Site & Exterior Improvements', group: 'buildings', description: 'Parking, paving, boundary walls, drainage, exterior structures and landscaping infrastructure.', life: 120, residual: 5, frequency: 180 }),
  category({ code: 'BUILDING', name: 'Buildings & Structures', group: 'buildings', description: 'Owned restaurant buildings, warehouses, kitchens, offices and permanent structures.', life: 240, residual: 10, frequency: 365 }),
  category({ code: 'LEASEHOLD', name: 'Leasehold Improvements', group: 'leasehold', description: 'Capital improvements to rented premises, including partitions, flooring and permanent fit-out.', life: 60, frequency: 180 }),
  category({ code: 'RENOVATION', name: 'Renovation & Interior Fit-out', group: 'leasehold', description: 'Interior construction, counters, ceilings, wall finishes and capital renovation projects.', life: 60, frequency: 180 }),

  category({ code: 'COOK-EQP', name: 'Cooking Equipment', group: 'kitchen', description: 'Ovens, ranges, fryers, grills, tandoors, steamers, hot plates and cooking lines.', life: 60, residual: 5, frequency: 60 }),
  category({ code: 'FOOD-PREP', name: 'Food Preparation Machinery', group: 'kitchen', description: 'Mixers, slicers, grinders, processors, dough machines, peelers and preparation machinery.', life: 60, residual: 5, frequency: 60 }),
  category({ code: 'REFRIG', name: 'Refrigeration Equipment', group: 'kitchen', description: 'Refrigerators, freezers, chillers, refrigerated counters and display coolers.', life: 84, residual: 5, frequency: 60 }),
  category({ code: 'COLD-STORE', name: 'Cold Rooms & Cold Storage', group: 'kitchen', description: 'Walk-in chillers, cold rooms, freezer rooms and their dedicated equipment.', life: 96, residual: 5, frequency: 60 }),
  category({ code: 'DISHWASH', name: 'Dishwashing & Sanitation Equipment', group: 'kitchen', description: 'Dishwashers, glass washers, sterilizers, pot washers and sanitation machines.', life: 60, frequency: 60 }),
  category({ code: 'BEVERAGE', name: 'Beverage & Bar Equipment', group: 'kitchen', description: 'Coffee machines, grinders, blenders, juicers, dispensers, ice makers and bar equipment.', life: 48, residual: 5, frequency: 60 }),
  category({ code: 'BAKERY', name: 'Bakery & Pastry Equipment', group: 'kitchen', description: 'Deck ovens, proofers, sheeters, planetary mixers and pastry production equipment.', life: 60, residual: 5, frequency: 60 }),
  category({ code: 'WATER-DISP', name: 'Water Dispensers & Ice Equipment', group: 'kitchen', description: 'Water dispensers, ice machines and related food-service water equipment.', life: 48, frequency: 60 }),

  category({ code: 'HVAC', name: 'HVAC, Exhaust & Ventilation', group: 'systems', description: 'Air-conditioning, extraction hoods, exhaust fans, make-up air and ventilation systems.', life: 84, residual: 5, frequency: 90 }),
  category({ code: 'ELECTRICAL', name: 'Electrical Systems & Equipment', group: 'systems', description: 'Distribution panels, transformers, stabilizers and dedicated electrical installations.', life: 120, residual: 5, frequency: 90 }),
  category({ code: 'GENERATOR', name: 'Generators & Backup Power', group: 'systems', description: 'Generators, automatic transfer switches and backup power equipment.', life: 84, residual: 10, frequency: 30 }),
  category({ code: 'SOLAR-UPS', name: 'Solar, UPS & Battery Systems', group: 'systems', description: 'Solar panels, inverters, UPS units, batteries and energy storage systems.', life: 84, residual: 5, frequency: 60 }),
  category({ code: 'GAS-SYSTEM', name: 'Gas Systems & Installations', group: 'systems', description: 'Gas manifolds, regulators, detectors, tanks and fixed distribution installations.', life: 120, frequency: 60 }),
  category({ code: 'PLUMBING', name: 'Plumbing, Pumps & Water Filtration', group: 'systems', description: 'Water pumps, filtration plants, softeners, tanks and capital plumbing equipment.', life: 96, frequency: 90 }),
  category({ code: 'FIRE-SAFE', name: 'Fire Safety & Emergency Equipment', group: 'systems', description: 'Extinguishers, fire suppression, alarms, emergency lights and emergency equipment.', life: 60, frequency: 30 }),
  category({ code: 'SECURITY', name: 'Security, CCTV & Access Control', group: 'systems', description: 'Cameras, recorders, access control, alarms, safes and security systems.', life: 60, frequency: 60 }),
  category({ code: 'WASTE-EQP', name: 'Waste Management Equipment', group: 'systems', description: 'Compactors, grease-management equipment and durable waste handling systems.', life: 60, frequency: 90 }),

  category({ code: 'POS', name: 'POS, Cashier & Payment Equipment', group: 'technology', description: 'POS terminals, cash drawers, receipt printers, payment terminals and customer displays.', life: 36, residual: 5, frequency: 30 }),
  category({ code: 'COMPUTER', name: 'Computers, Servers & Storage', group: 'technology', description: 'Desktop computers, laptops, servers, storage appliances and related hardware.', life: 36, residual: 5, frequency: 60 }),
  category({ code: 'NETWORK', name: 'Networking & Telecommunications', group: 'technology', description: 'Routers, switches, access points, firewalls, intercoms and telephone equipment.', life: 48, residual: 5, frequency: 60 }),
  category({ code: 'OFFICE-EQP', name: 'Office Equipment', group: 'technology', description: 'Printers, scanners, copiers, attendance terminals and administrative equipment.', life: 48, frequency: 90 }),

  category({ code: 'DINING-FURN', name: 'Dining Furniture', group: 'furniture', description: 'Dining tables, chairs, booths, benches, high chairs and guest seating.', trackingMode: 'bulk', life: 60, residual: 5, frequency: 60 }),
  category({ code: 'KITCH-FURN', name: 'Kitchen Furniture & Workstations', group: 'furniture', description: 'Stainless work tables, sinks, counters, cabinets and mobile workstations.', trackingMode: 'bulk', life: 84, residual: 5, frequency: 60 }),
  category({ code: 'OUTDOOR-FURN', name: 'Outdoor Furniture & Fixtures', group: 'furniture', description: 'Outdoor tables, chairs, umbrellas, barriers and weather-resistant fixtures.', trackingMode: 'bulk', life: 48, frequency: 60 }),
  category({ code: 'STORAGE', name: 'Storage, Shelving & Racking', group: 'furniture', description: 'Shelving, racks, bins, lockers, cabinets and durable storage systems.', trackingMode: 'bulk', life: 84, frequency: 90 }),
  category({ code: 'LIGHT-DECOR', name: 'Lighting & Decorative Fixtures', group: 'furniture', description: 'Decorative lighting, chandeliers, artwork, mirrors and durable décor fixtures.', trackingMode: 'bulk', life: 60, frequency: 90 }),
  category({ code: 'SIGNAGE', name: 'Signage, Branding & Displays', group: 'furniture', description: 'External signs, menu boards, digital displays and permanent branded fixtures.', life: 48, frequency: 90 }),

  category({ code: 'CROCKERY', name: 'Crockery & Dinnerware', group: 'tableware', description: 'Reusable plates, bowls, serving dishes and ceramic dinnerware.', trackingMode: 'bulk', defaultUnit: 'piece', life: 24, frequency: 30 }),
  category({ code: 'CUTLERY', name: 'Cutlery & Flatware', group: 'tableware', description: 'Reusable knives, forks, spoons and serving flatware.', trackingMode: 'bulk', defaultUnit: 'piece', life: 24, frequency: 30 }),
  category({ code: 'GLASSWARE', name: 'Glassware', group: 'tableware', description: 'Reusable drinking glasses, cups, mugs, pitchers and specialty glassware.', trackingMode: 'bulk', defaultUnit: 'piece', life: 18, frequency: 30 }),
  category({ code: 'SMALLWARE', name: 'Kitchen Smallwares & Utensils', group: 'tableware', description: 'Pans, pots, trays, knives, utensils, containers and durable kitchen tools.', trackingMode: 'bulk', defaultUnit: 'piece', life: 36, frequency: 30 }),
  category({ code: 'LINEN', name: 'Reusable Linen, Uniforms & Textiles', group: 'tableware', description: 'Table linen, reusable napkins, curtains, staff uniforms and durable textiles.', trackingMode: 'bulk', defaultUnit: 'piece', life: 24, frequency: 30 }),
  category({ code: 'REUSE-PACK', name: 'Reusable Crates, Containers & Packaging', group: 'tableware', description: 'Returnable crates, insulated boxes, delivery bags and reusable food containers.', trackingMode: 'bulk', defaultUnit: 'piece', life: 24, frequency: 30 }),

  category({ code: 'CLEAN-EQP', name: 'Cleaning & Janitorial Equipment', group: 'other', description: 'Scrubbers, vacuum cleaners, pressure washers, housekeeping carts and cleaning machinery.', life: 48, frequency: 60 }),
  category({ code: 'LAUNDRY', name: 'Laundry Equipment', group: 'other', description: 'Washers, dryers, irons and linen-care equipment.', life: 60, frequency: 60 }),
  category({ code: 'DELIVERY-VEH', name: 'Delivery Cars, Vans & Trucks', group: 'vehicles', description: 'Cars, vans, refrigerated vehicles and trucks used by the business.', life: 60, residual: 20, frequency: 30 }),
  category({ code: 'DELIVERY-2W', name: 'Delivery Motorcycles & Bicycles', group: 'vehicles', description: 'Motorcycles, scooters, bicycles and e-bikes used for delivery.', life: 48, residual: 10, frequency: 30 }),
  category({ code: 'HANDLING', name: 'Material Handling & Trolleys', group: 'vehicles', description: 'Trolleys, pallet jacks, carts, dollies and durable handling equipment.', trackingMode: 'bulk', life: 60, frequency: 60 }),
  category({ code: 'TOOLS', name: 'Tools, Workshop & Maintenance Equipment', group: 'other', description: 'Power tools, workshop equipment, ladders and maintenance tool sets.', trackingMode: 'bulk', life: 48, frequency: 60 }),
  category({ code: 'AV-EQP', name: 'Audio, Music & Entertainment Equipment', group: 'other', description: 'Speakers, amplifiers, televisions, projectors and entertainment systems.', life: 48, residual: 5, frequency: 60 }),
  category({ code: 'GUEST-AMEN', name: 'Guest Amenities & Play Equipment', group: 'other', description: 'Children’s play equipment, guest charging stations and durable guest amenities.', life: 60, frequency: 60 }),
  category({ code: 'OTHER-ASSET', name: 'Other Fixed Assets', group: 'other', description: 'Capital assets that do not fit another category.', life: 60, frequency: 90 }),
];

if (
  new Set(ACCOUNT_DEFINITIONS.map((row) => row.key)).size !== ACCOUNT_DEFINITIONS.length
  || new Set(ACCOUNT_DEFINITIONS.map((row) => row.code)).size !== ACCOUNT_DEFINITIONS.length
) {
  throw new Error('Default asset account keys and codes must be unique.');
}
if (new Set(CATEGORY_DEFINITIONS.map((row) => row.code)).size !== CATEGORY_DEFINITIONS.length) {
  throw new Error('Default asset category codes must be unique.');
}
const defaultAccountKeys = new Set(ACCOUNT_DEFINITIONS.map((row) => row.key));
for (const definition of CATEGORY_DEFINITIONS) {
  const group = GROUPS[definition.group];
  if (!group || Object.values(group).some((key) => !defaultAccountKeys.has(key))) {
    throw new Error(`Default asset category ${definition.code} has an invalid account group.`);
  }
}

const compatibleAccount = (account, definition) => (
  account
  && account.isActive !== false
  && account.type === definition.type
  && account.normalBalance === definition.normalBalance
);

const matchesDefinition = (account, definition) => (
  compatibleAccount(account, definition)
  && String(account.name || '').trim().toLowerCase()
    === String(definition.name).trim().toLowerCase()
);

const createFallbackAccount = async (definition) => {
  for (let suffix = 1; suffix <= 20; suffix += 1) {
    const code = `${definition.code}-A${suffix}`;
    const existing = await ChartOfAccounts.findOne({ code });
    if (matchesDefinition(existing, definition)) return existing;
    if (existing) continue;
    try {
      return await ChartOfAccounts.create({
        ...definition,
        code,
        isSystemAccount: true,
        isActive: true,
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
  }
  throw new Error(`Could not reserve a compatible account code for ${definition.name}.`);
};

const ensureAccount = async (definition) => {
  let account = await ChartOfAccounts.findOne({ code: definition.code });
  if (matchesDefinition(account, definition)) return account;
  if (account) {
    account = await ChartOfAccounts.findOne({
      name: definition.name,
      type: definition.type,
      normalBalance: definition.normalBalance,
    });
    if (account) return account;
    return createFallbackAccount(definition);
  }
  try {
    return await ChartOfAccounts.create({
      ...definition,
      isSystemAccount: true,
      isActive: true,
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    account = await ChartOfAccounts.findOne({ code: definition.code });
    return matchesDefinition(account, definition)
      ? account
      : createFallbackAccount(definition);
  }
};

const bootstrapByTenant = new Map();

const bootstrap = async () => {
  const accounts = {};
  for (const definition of ACCOUNT_DEFINITIONS) {
    accounts[definition.key] = await ensureAccount(definition);
  }

  let inserted = 0;
  let completed = 0;
  for (const definition of CATEGORY_DEFINITIONS) {
    const group = GROUPS[definition.group];
    const mappings = {
      asset: accounts[group.asset]._id,
      accumulatedDepreciation: group.accumulatedDepreciation
        ? accounts[group.accumulatedDepreciation]._id
        : null,
      depreciationExpense: group.depreciationExpense
        ? accounts[group.depreciationExpense]._id
        : null,
      lossOnDisposal: accounts.writeOff._id,
      gainOnDisposal: accounts.gain._id,
    };
    const payload = {
      code: definition.code,
      name: definition.name,
      description: definition.description,
      trackingMode: definition.trackingMode,
      defaultUnit: definition.defaultUnit,
      defaultUsefulLifeMonths: definition.defaultUsefulLifeMonths,
      defaultResidualValuePercent: definition.defaultResidualValuePercent,
      depreciationMethod: definition.depreciationMethod,
      auditFrequencyDays: definition.auditFrequencyDays,
      capitalisationThreshold: definition.capitalisationThreshold,
      accounts: mappings,
      isActive: true,
    };
    let categoryDoc;
    try {
      categoryDoc = await AssetCategory.findOneAndUpdate(
        { code: definition.code },
        { $setOnInsert: payload },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
      );
    } catch (error) {
      if (error?.code !== 11000) throw error;
      categoryDoc = await AssetCategory.findOne({ code: definition.code });
    }
    if (!categoryDoc) continue;
    if (
      categoryDoc.createdAt
      && categoryDoc.updatedAt
      && categoryDoc.createdAt.getTime() === categoryDoc.updatedAt.getTime()
    ) inserted += 1;

    const missingMappings = {};
    for (const [key, value] of Object.entries(mappings)) {
      if (value && !categoryDoc.accounts?.[key]) {
        missingMappings[`accounts.${key}`] = value;
      }
    }
    if (Object.keys(missingMappings).length) {
      await AssetCategory.updateOne({ _id: categoryDoc._id }, { $set: missingMappings });
      completed += 1;
    }
  }

  if (inserted || completed) {
    logger.info(
      `Asset defaults ready: ${inserted} categor${inserted === 1 ? 'y' : 'ies'} inserted, ` +
      `${completed} existing categor${completed === 1 ? 'y' : 'ies'} completed.`,
    );
  }
  return {
    accounts: ACCOUNT_DEFINITIONS.length,
    categories: CATEGORY_DEFINITIONS.length,
  };
};

export const ensureAssetDefaults = async () => {
  const tenantKey = getTenantStore()?.slug || 'current';
  if (!bootstrapByTenant.has(tenantKey)) {
    const promise = bootstrap().catch((error) => {
      bootstrapByTenant.delete(tenantKey);
      throw error;
    });
    bootstrapByTenant.set(tenantKey, promise);
  }
  return bootstrapByTenant.get(tenantKey);
};

export const DEFAULT_ASSET_CATEGORY_COUNT = CATEGORY_DEFINITIONS.length;

export default ensureAssetDefaults;
