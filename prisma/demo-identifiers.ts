export const DEMO_OUTLET_CODES = ['MIRPUR', 'GULSHAN', 'DHANMONDI', 'UTTARA', 'BANANI'] as const;
export type DemoOutletCode = (typeof DEMO_OUTLET_CODES)[number];

export const DEMO_ITEM_SKUS = [
  'BRG-CLASSIC',
  'BRG-CHICKEN',
  'BRG-DOUBLE',
  'BRG-NAGA',
  'SND-CLUB',
  'SND-TUNA',
  'SND-SHAWARMA',
  'PZA-MARGHERITA',
  'PZA-BBQ',
  'PZA-BEEF',
  'PST-ALFREDO',
  'PST-ARRABBIATA',
  'RCE-BIRYANI',
  'RCE-TERIYAKI',
  'RCE-KHICHURI',
  'FCK-2PC',
  'FCK-WINGS',
  'FCK-BUCKET',
  'SNK-FRIES',
  'SNK-NUGGETS',
  'SNK-ONION',
  'SNK-SINGARA',
  'COF-ESPRESSO',
  'COF-CAPPUCCINO',
  'COF-ICED-LATTE',
  'TEA-MILK',
  'TEA-LEMON',
  'CLD-WATER',
  'CLD-LEMONADE',
  'CLD-MANGO-LASSI',
  'CLD-SODA',
  'RCE-NIHARI',
] as const;
export type DemoItemSku = (typeof DEMO_ITEM_SKUS)[number];

export const DEMO_STAFF_EMAILS = [
  'staff.mirpur@example.com',
  'staff.gulshan@example.com',
  'staff.dhanmondi@example.com',
  'staff.uttara@example.com',
  'staff.multi@example.com',
  'staff.manager@example.com',
] as const;
export type DemoStaffEmail = (typeof DEMO_STAFF_EMAILS)[number];
