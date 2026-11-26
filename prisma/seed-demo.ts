import '@/config/load-env.js';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import type { AuthenticatedUser } from '@/common/types/http.js';
import { loadConfig } from '@/config/env.js';
import { createPrismaClient } from '@/database/client.js';
import { Role } from '@/generated/prisma/enums.js';
import { InventoryRepository } from '@/modules/inventory/inventory.repository.js';
import { InventoryService } from '@/modules/inventory/inventory.service.js';
import { MenuItemRepository } from '@/modules/menu-items/menu-item.repository.js';
import { MenuItemService } from '@/modules/menu-items/menu-item.service.js';
import { OutletMenuItemRepository } from '@/modules/outlet-menu-items/outlet-menu-item.repository.js';
import { OutletMenuItemService } from '@/modules/outlet-menu-items/outlet-menu-item.service.js';
import { OutletRepository } from '@/modules/outlets/outlet.repository.js';
import { OutletService } from '@/modules/outlets/outlet.service.js';
import { SaleRepository } from '@/modules/sales/sale.repository.js';
import { SaleService } from '@/modules/sales/sale.service.js';
import { StaffRepository } from '@/modules/staff/staff.repository.js';
import { StaffService } from '@/modules/staff/staff.service.js';
import { DEMO_OUTLET_CODES, DEMO_STAFF_EMAILS } from './demo-identifiers.js';

const ROTATE = process.argv.includes('--rotate-demo-passwords');
const CREDENTIALS_FILE = process.env.DEMO_CREDENTIALS_FILE;
const DAY_MS = 86_400_000;
const DHAKA_OFFSET_HOURS = 6;
const SALES_DAYS = 30;
const BANANI_LAST_SALES_DAY = 11;
const TARGET_SALES = 400;
const CREATED_BEFORE_TARGET_CHANGE = 325;

type OutletKey = 'MIRPUR' | 'GULSHAN' | 'DHANMONDI' | 'UTTARA' | 'BANANI';

const OUTLETS: Record<OutletKey, { code: string; name: string; address: string; sales: number }> = {
  MIRPUR: {
    code: 'MIRPUR',
    name: 'Mirpur Outlet',
    address: 'House 14, Road 2, Section 10, Mirpur, Dhaka 1216',
    sales: 170,
  },
  GULSHAN: {
    code: 'GULSHAN',
    name: 'Gulshan Outlet',
    address: 'Plot 51, Gulshan Avenue, Gulshan 1, Dhaka 1212',
    sales: 150,
  },
  DHANMONDI: {
    code: 'DHANMONDI',
    name: 'Dhanmondi Outlet',
    address: 'House 27, Road 8A, Dhanmondi, Dhaka 1209',
    sales: 110,
  },
  UTTARA: {
    code: 'UTTARA',
    name: 'Uttara Outlet',
    address: 'House 9, Road 11, Sector 7, Uttara, Dhaka 1230',
    sales: 0,
  },
  BANANI: {
    code: 'BANANI',
    name: 'Banani Outlet',
    address: 'House 66, Road 11, Block E, Banani, Dhaka 1213',
    sales: 70,
  },
};
const OUTLET_KEYS = Object.keys(OUTLETS) as OutletKey[];
const ACTIVE_KEYS: OutletKey[] = ['MIRPUR', 'GULSHAN', 'DHANMONDI', 'UTTARA'];

type Item = {
  sku: string;
  name: string;
  description: string;
  price: string;
  kind:
    | 'burger'
    | 'sandwich'
    | 'pizza'
    | 'pasta'
    | 'rice'
    | 'chicken'
    | 'snack'
    | 'coffee'
    | 'tea'
    | 'cold';
  core?: boolean;
  retired?: boolean;
};

const ITEMS: Item[] = [
  {
    sku: 'BRG-CLASSIC',
    name: 'Classic Beef Burger',
    description: 'Grilled beef patty, cheddar, lettuce, tomato and house sauce',
    price: '350.00',
    kind: 'burger',
    core: true,
  },
  {
    sku: 'BRG-CHICKEN',
    name: 'Crispy Chicken Burger',
    description: 'Buttermilk fried chicken thigh with coleslaw and mayo',
    price: '320.00',
    kind: 'burger',
    core: true,
  },
  {
    sku: 'BRG-DOUBLE',
    name: 'Double Smash Burger',
    description: 'Two smashed beef patties, American cheese and pickles',
    price: '520.00',
    kind: 'burger',
  },
  {
    sku: 'BRG-NAGA',
    name: 'Naga Fire Burger',
    description: 'Beef patty with naga chilli sauce and jalapenos',
    price: '390.00',
    kind: 'burger',
  },
  {
    sku: 'SND-CLUB',
    name: 'Chicken Club Sandwich',
    description: 'Triple-decker with grilled chicken, egg and cheese',
    price: '290.00',
    kind: 'sandwich',
    core: true,
  },
  {
    sku: 'SND-TUNA',
    name: 'Tuna Melt Sandwich',
    description: 'Tuna, mozzarella and onion on toasted sourdough',
    price: '310.00',
    kind: 'sandwich',
  },
  {
    sku: 'SND-SHAWARMA',
    name: 'Chicken Shawarma Wrap',
    description: 'Spiced chicken, garlic sauce and pickles in pita',
    price: '220.00',
    kind: 'sandwich',
    core: true,
  },
  {
    sku: 'PZA-MARGHERITA',
    name: 'Margherita Pizza (10")',
    description: 'Tomato sauce, mozzarella and basil',
    price: '650.00',
    kind: 'pizza',
    core: true,
  },
  {
    sku: 'PZA-BBQ',
    name: 'BBQ Chicken Pizza (10")',
    description: 'Smoky BBQ chicken, onion and capsicum',
    price: '780.00',
    kind: 'pizza',
  },
  {
    sku: 'PZA-BEEF',
    name: 'Beef Pepperoni Pizza (10")',
    description: 'Halal beef pepperoni and mozzarella',
    price: '850.00',
    kind: 'pizza',
  },
  {
    sku: 'PST-ALFREDO',
    name: 'Chicken Alfredo Pasta',
    description: 'Fettuccine in creamy parmesan sauce with chicken',
    price: '450.00',
    kind: 'pasta',
    core: true,
  },
  {
    sku: 'PST-ARRABBIATA',
    name: 'Penne Arrabbiata',
    description: 'Penne in spicy tomato and garlic sauce',
    price: '380.00',
    kind: 'pasta',
  },
  {
    sku: 'RCE-BIRYANI',
    name: 'Kacchi Biryani Bowl',
    description: 'Basmati rice with tender mutton and aloo',
    price: '420.00',
    kind: 'rice',
    core: true,
  },
  {
    sku: 'RCE-TERIYAKI',
    name: 'Chicken Teriyaki Rice Bowl',
    description: 'Glazed chicken over steamed rice and vegetables',
    price: '360.00',
    kind: 'rice',
    core: true,
  },
  {
    sku: 'RCE-KHICHURI',
    name: 'Beef Khichuri Bowl',
    description: 'Lentil rice with slow-cooked beef',
    price: '330.00',
    kind: 'rice',
  },
  {
    sku: 'FCK-2PC',
    name: 'Fried Chicken (2 pcs)',
    description: 'Crispy spiced fried chicken, two pieces',
    price: '280.00',
    kind: 'chicken',
    core: true,
  },
  {
    sku: 'FCK-WINGS',
    name: 'Hot Wings (6 pcs)',
    description: 'Chicken wings tossed in hot sauce',
    price: '340.00',
    kind: 'chicken',
    core: true,
  },
  {
    sku: 'FCK-BUCKET',
    name: 'Family Chicken Bucket (8 pcs)',
    description: 'Eight pieces of fried chicken for sharing',
    price: '1050.00',
    kind: 'chicken',
  },
  {
    sku: 'SNK-FRIES',
    name: 'French Fries',
    description: 'Salted crispy potato fries',
    price: '150.00',
    kind: 'snack',
    core: true,
  },
  {
    sku: 'SNK-NUGGETS',
    name: 'Chicken Nuggets (8 pcs)',
    description: 'Golden chicken nuggets with dip',
    price: '240.00',
    kind: 'snack',
    core: true,
  },
  {
    sku: 'SNK-ONION',
    name: 'Onion Rings',
    description: 'Beer-batter style onion rings (alcohol-free)',
    price: '180.00',
    kind: 'snack',
  },
  {
    sku: 'SNK-SINGARA',
    name: 'Singara (2 pcs)',
    description: 'Potato and pea filled pastry',
    price: '40.00',
    kind: 'snack',
  },
  {
    sku: 'COF-ESPRESSO',
    name: 'Espresso',
    description: 'Double shot espresso',
    price: '180.00',
    kind: 'coffee',
  },
  {
    sku: 'COF-CAPPUCCINO',
    name: 'Cappuccino',
    description: 'Espresso with steamed milk foam',
    price: '260.00',
    kind: 'coffee',
    core: true,
  },
  {
    sku: 'COF-ICED-LATTE',
    name: 'Iced Caramel Latte',
    description: 'Chilled latte with caramel syrup',
    price: '320.00',
    kind: 'coffee',
  },
  {
    sku: 'TEA-MILK',
    name: 'Milk Tea',
    description: 'Traditional Bangladeshi doodh cha',
    price: '40.00',
    kind: 'tea',
    core: true,
  },
  {
    sku: 'TEA-LEMON',
    name: 'Lemon Mint Tea',
    description: 'Black tea with lemon and fresh mint',
    price: '60.00',
    kind: 'tea',
  },
  {
    sku: 'CLD-WATER',
    name: 'Mineral Water (500 ml)',
    description: 'Bottled drinking water',
    price: '30.00',
    kind: 'cold',
    core: true,
  },
  {
    sku: 'CLD-LEMONADE',
    name: 'Fresh Lemonade',
    description: 'Fresh lime, sugar and soda',
    price: '120.00',
    kind: 'cold',
    core: true,
  },
  {
    sku: 'CLD-MANGO-LASSI',
    name: 'Mango Lassi',
    description: 'Seasonal mango yogurt drink',
    price: '170.00',
    kind: 'cold',
    retired: true,
  },
  {
    sku: 'CLD-SODA',
    name: 'Soft Drink (250 ml)',
    description: 'Chilled carbonated soft drink',
    price: '50.00',
    kind: 'cold',
    core: true,
  },
  {
    sku: 'RCE-NIHARI',
    name: 'Beef Nihari with Rice',
    description: 'Discontinued slow-cooked nihari plate',
    price: '480.00',
    kind: 'rice',
    retired: true,
  },
];

const EXTRAS: Record<OutletKey, string[]> = {
  MIRPUR: ['BRG-DOUBLE', 'BRG-NAGA', 'SNK-SINGARA', 'TEA-LEMON', 'RCE-KHICHURI', 'CLD-MANGO-LASSI'],
  GULSHAN: [
    'BRG-DOUBLE',
    'PZA-BBQ',
    'PZA-BEEF',
    'COF-ESPRESSO',
    'COF-ICED-LATTE',
    'SND-TUNA',
    'PST-ARRABBIATA',
    'RCE-NIHARI',
  ],
  DHANMONDI: [
    'PST-ARRABBIATA',
    'RCE-KHICHURI',
    'COF-ICED-LATTE',
    'SNK-ONION',
    'TEA-LEMON',
    'CLD-MANGO-LASSI',
  ],
  UTTARA: ['BRG-NAGA', 'FCK-BUCKET', 'SNK-SINGARA', 'PZA-BBQ', 'RCE-NIHARI'],
  BANANI: ['FCK-BUCKET', 'PZA-BEEF', 'COF-ESPRESSO', 'SNK-ONION', 'SND-TUNA'],
};

const OVERRIDES: Partial<Record<OutletKey, Record<string, string>>> = {
  MIRPUR: { 'TEA-MILK': '35.00', 'BRG-CLASSIC': '330.00' },
  GULSHAN: {
    'COF-CAPPUCCINO': '290.00',
    'PZA-MARGHERITA': '720.00',
    'BRG-CLASSIC': '390.00',
    'CLD-WATER': '40.00',
  },
  DHANMONDI: { 'CLD-WATER': '0.00', 'PST-ALFREDO': '430.00' },
  BANANI: { 'FCK-2PC': '300.00', 'COF-CAPPUCCINO': '280.00' },
};

const INACTIVE_ASSIGNMENTS: Partial<Record<OutletKey, string[]>> = {
  MIRPUR: ['PST-ALFREDO'],
  GULSHAN: ['SND-SHAWARMA'],
  UTTARA: ['COF-CAPPUCCINO'],
};

const BOOSTS: Record<OutletKey, Partial<Record<Item['kind'], number>>> = {
  MIRPUR: { burger: 4, tea: 3, snack: 2 },
  GULSHAN: { coffee: 4, pizza: 3, sandwich: 2 },
  DHANMONDI: { rice: 4, pasta: 3, cold: 2 },
  UTTARA: {},
  BANANI: { chicken: 4, snack: 2, cold: 2 },
};

const STAFF: { email: string; outlets: OutletKey[] }[] = [
  { email: DEMO_STAFF_EMAILS[0], outlets: ['MIRPUR'] },
  { email: DEMO_STAFF_EMAILS[1], outlets: ['GULSHAN'] },
  { email: DEMO_STAFF_EMAILS[2], outlets: ['DHANMONDI'] },
  { email: DEMO_STAFF_EMAILS[3], outlets: ['UTTARA'] },
  { email: DEMO_STAFF_EMAILS[4], outlets: ['MIRPUR', 'GULSHAN'] },
  { email: DEMO_STAFF_EMAILS[5], outlets: ACTIVE_KEYS },
];
const BANANI_CASHIER = 'staff.manager@example.com';

function demoUuid(key: string): string {
  const hex = createHash('sha256').update(`outlethub-demo:${key}`).digest('hex');
  const variant = ((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function prng(seed: string): () => number {
  let state = parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(random: () => number, entries: readonly { value: T; weight: number }[]): T {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = random() * total;
  for (const entry of entries) {
    roll -= entry.weight;
    if (roll < 0) return entry.value;
  }
  const last = entries.at(-1);
  if (!last) throw new Error('Cannot pick from an empty list');
  return last.value;
}

const ITEM_BY_SKU = new Map(ITEMS.map((item) => [item.sku, item]));
const itemOf = (sku: string): Item => {
  const item = ITEM_BY_SKU.get(sku);
  if (!item) throw new Error(`Unknown seed SKU ${sku}`);
  return item;
};
const menuOf = (outlet: OutletKey): string[] => [
  ...ITEMS.filter((item) => item.core).map((item) => item.sku),
  ...EXTRAS[outlet],
];
const priceOf = (outlet: OutletKey, sku: string): string =>
  OVERRIDES[outlet]?.[sku] ?? itemOf(sku).price;
const sellable = (outlet: OutletKey, sku: string): boolean =>
  !itemOf(sku).retired &&
  !INACTIVE_ASSIGNMENTS[outlet]?.includes(sku) &&
  priceOf(outlet, sku) !== '0.00';

type PlannedSale = {
  outlet: OutletKey;
  requestId: string;
  at: Date;
  cashier: string;
  lines: { sku: string; quantity: number }[];
};

function planSales(anchorDay: Date): PlannedSale[] {
  const plan: PlannedSale[] = [];
  for (const outlet of OUTLET_KEYS) {
    const { sales } = OUTLETS[outlet];
    if (!sales) continue;
    const random = prng(`sales:${outlet}`);
    const firstDay = outlet === 'BANANI' ? BANANI_LAST_SALES_DAY : 1;
    const days = Array.from({ length: SALES_DAYS - firstDay + 1 }, (_, index) => {
      const daysAgo = firstDay + index;
      const date = new Date(anchorDay.getTime() - daysAgo * DAY_MS);
      const weekday = new Date(date.getTime() + DHAKA_OFFSET_HOURS * 3_600_000).getUTCDay();
      const weekend = weekday === 5 || weekday === 6 ? 1.5 : 1;
      return { value: date, weight: weekend * (0.6 + random() * 0.8) };
    });
    const candidates = menuOf(outlet).filter((sku) => sellable(outlet, sku));
    const weights = candidates.map((sku) => ({
      value: sku,
      weight: (1 + (BOOSTS[outlet][itemOf(sku).kind] ?? 0)) * (0.5 + random()),
    }));
    const cashiers = STAFF.filter((staff) => staff.outlets.includes(outlet)).map(
      (staff) => staff.email,
    );
    const drafts: Omit<PlannedSale, 'requestId'>[] = [];
    for (let index = 0; index < sales; index += 1) {
      const day = pick(random, days);
      const slot = pick(random, [
        { value: { low: 8, high: 11 }, weight: 2 },
        { value: { low: 12, high: 16 }, weight: 4 },
        { value: { low: 17, high: 22 }, weight: 5 },
      ]);
      const hour = slot.low + Math.floor(random() * (slot.high - slot.low + 1));
      const minute = Math.floor(random() * 60);
      const second = Math.floor(random() * 60);
      const at = new Date(day.getTime() + (hour * 3600 + minute * 60 + second) * 1000);
      const lineCount = pick(random, [
        { value: 1, weight: 4 },
        { value: 2, weight: 4 },
        { value: 3, weight: 2 },
        { value: 4, weight: 1 },
      ]);
      const chosen = new Map<string, number>();
      while (chosen.size < lineCount) {
        const sku = pick(random, weights);
        if (chosen.has(sku)) continue;
        const kind = itemOf(sku).kind;
        const max = kind === 'tea' || kind === 'cold' || kind === 'snack' ? 4 : 2;
        chosen.set(sku, 1 + Math.floor(random() * max));
      }
      drafts.push({
        outlet,
        at,
        cashier:
          outlet === 'BANANI'
            ? BANANI_CASHIER
            : (cashiers[Math.floor(random() * cashiers.length)] ?? ''),
        lines: [...chosen].map(([sku, quantity]) => ({ sku, quantity })),
      });
    }
    drafts
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .forEach((draft, index) =>
        plan.push({ ...draft, requestId: demoUuid(`sale:${outlet}:${index + 1}`) }),
      );
  }
  return plan.sort((a, b) => a.at.getTime() - b.at.getTime());
}

function limitPlan(full: PlannedSale[]): PlannedSale[] {
  const keepTail = TARGET_SALES - CREATED_BEFORE_TARGET_CHANGE;
  const tailLength = full.length - CREATED_BEFORE_TARGET_CHANGE;
  return full.filter((_, index) => {
    if (index < CREATED_BEFORE_TARGET_CHANGE) return true;
    const offset = index - CREATED_BEFORE_TARGET_CHANGE;
    return (
      Math.floor(((offset + 1) * keepTail) / tailLength) !==
      Math.floor((offset * keepTail) / tailLength)
    );
  });
}

function remainingStock(outlet: OutletKey, sku: string): number {
  const random = prng(`stock:${outlet}:${sku}`);
  const tier = pick(random, [
    { value: { low: 50, high: 200 }, weight: 55 },
    { value: { low: 15, high: 50 }, weight: 25 },
    { value: { low: 1, high: 10 }, weight: 12 },
    { value: { low: 0, high: 0 }, weight: 8 },
  ]);
  return tier.low + Math.floor(random() * (tier.high - tier.low + 1));
}

const dhakaMidnight = (date: Date): Date => {
  const local = new Date(date.getTime() + DHAKA_OFFSET_HOURS * 3_600_000);
  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) -
      DHAKA_OFFSET_HOURS * 3_600_000,
  );
};

const newPassword = (): string => `${randomBytes(15).toString('base64url')}-Dm7`;
const log = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

const config = loadConfig();
const db = createPrismaClient(config);
const outletService = new OutletService(new OutletRepository(db));
const menuService = new MenuItemService(new MenuItemRepository(db));
const outletMenuService = new OutletMenuItemService(new OutletMenuItemRepository(db));
const inventoryService = new InventoryService(new InventoryRepository(db));
const staffService = new StaffService(new StaffRepository(db));
const saleService = new SaleService(new SaleRepository(db));

async function main(): Promise<void> {
  const [target] = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  log(`Seeding demo data into database "${target?.name ?? '?'}"`);

  const adminRow = await db.user.findFirst({
    where: { role: Role.HQ_ADMIN, isActive: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true, email: true, role: true },
  });
  if (!adminRow) throw new Error('An active HQ admin is required as the actor for demo writes.');
  const admin: AuthenticatedUser = adminRow;

  const outletIds = {} as Record<OutletKey, string>;
  for (const key of OUTLET_KEYS) {
    const plan = OUTLETS[key];
    const existing = await db.outlet.findUnique({ where: { code: plan.code } });
    if (existing) {
      if (existing.name !== plan.name) {
        throw new Error(
          `Outlet ${plan.code} exists but is not the demo outlet; refusing to touch it.`,
        );
      }
      outletIds[key] = existing.id;
    } else {
      outletIds[key] = (
        await outletService.create({ code: plan.code, name: plan.name, address: plan.address })
      ).id;
      log(`Created outlet ${plan.code}`);
    }
  }
  const anchorOutlet = await db.outlet.findUniqueOrThrow({ where: { id: outletIds.MIRPUR } });
  const anchorDay = dhakaMidnight(anchorOutlet.createdAt);

  const itemIds = new Map<string, string>();
  for (const item of ITEMS) {
    const existing = await db.menuItem.findUnique({ where: { sku: item.sku } });
    if (existing) {
      if (existing.name !== item.name)
        throw new Error(`SKU ${item.sku} is not a demo item; refusing to touch it.`);
      itemIds.set(item.sku, existing.id);
    } else {
      const created = await menuService.create({
        sku: item.sku,
        name: item.name,
        description: item.description,
        basePrice: item.price,
      });
      itemIds.set(item.sku, created.id);
    }
  }
  const idOf = (sku: string): string => {
    const id = itemIds.get(sku);
    if (!id) throw new Error(`Missing demo item ${sku}`);
    return id;
  };

  const plan = limitPlan(planSales(anchorDay));
  if (plan.length !== TARGET_SALES)
    throw new Error(`Demo plan has ${plan.length} sales, expected ${TARGET_SALES}`);
  const planned = new Set(plan.map((sale) => sale.requestId));
  const smokeHex = createHash('sha256')
    .update('outlethub-demo:smoke-sale:staff.mirpur:1')
    .digest('hex');
  const smokeRequestId = `${smokeHex.slice(0, 8)}-${smokeHex.slice(8, 12)}-4${smokeHex.slice(13, 16)}-a${smokeHex.slice(17, 20)}-${smokeHex.slice(20, 32)}`;
  const strays = await db.sale.count({
    where: {
      outlet: { code: { in: [...DEMO_OUTLET_CODES] } },
      requestId: { notIn: [...planned, smokeRequestId] },
    },
  });
  if (strays > 0) {
    throw new Error(
      `${strays} demo sales are not in the ${TARGET_SALES}-sale plan; refusing to continue.`,
    );
  }
  const consumption = new Map<string, number>();
  for (const sale of plan) {
    for (const line of sale.lines) {
      const key = `${sale.outlet}:${line.sku}`;
      consumption.set(key, (consumption.get(key) ?? 0) + line.quantity);
    }
  }

  const bananiDone = !(await db.outlet.findUniqueOrThrow({ where: { id: outletIds.BANANI } }))
    .isActive;
  let assignmentsCreated = 0;
  let replenished = 0;
  for (const outlet of OUTLET_KEYS) {
    for (const sku of menuOf(outlet)) {
      const outletId = outletIds[outlet];
      const menuItemId = idOf(sku);
      let assignment = await db.outletMenuItem.findUnique({
        where: { outletId_menuItemId: { outletId, menuItemId } },
      });
      if (!assignment) {
        if (outlet === 'BANANI' && bananiDone) continue;
        const master = await db.menuItem.findUniqueOrThrow({ where: { id: menuItemId } });
        if (!master.isActive) continue;
        const override = OVERRIDES[outlet]?.[sku] ?? null;
        await outletMenuService.assign(admin, outletId, menuItemId, override);
        assignmentsCreated += 1;
        assignment = await db.outletMenuItem.findUniqueOrThrow({
          where: { outletId_menuItemId: { outletId, menuItemId } },
        });
      }
      const sold = await db.saleItem.aggregate({
        where: { outletId, menuItemId },
        _sum: { quantity: true },
      });
      const target = remainingStock(outlet, sku) + (consumption.get(`${outlet}:${sku}`) ?? 0);
      const outletActive = outlet !== 'BANANI' || !bananiDone;
      if (assignment.stockQuantity === 0 && !sold._sum.quantity && target > 0 && outletActive) {
        await inventoryService.adjust(admin, outletId, menuItemId, {
          operation: 'INCREASE',
          quantity: target,
        });
        replenished += 1;
      }
    }
  }
  log(
    `Assignments created: ${assignmentsCreated}; stock replenished on ${replenished} assignments`,
  );

  const credentials: { email: string; password: string; outlets: string[] }[] = [];
  const remember = (entry: { email: string; password: string; outlets: string[] }): void => {
    credentials.push(entry);
    log(`  credential issued: ${entry.email}  ${entry.password}  [${entry.outlets.join(', ')}]`);
    if (CREDENTIALS_FILE) {
      writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2), { mode: 0o600 });
      chmodSync(CREDENTIALS_FILE, 0o600);
    }
  };
  const staffIds = new Map<string, string>();
  for (const member of STAFF) {
    const wanted = member.outlets.map((key) => outletIds[key]);
    const existing = await db.user.findUnique({
      where: { email: member.email },
      include: { memberships: { include: { outlet: { select: { code: true } } } } },
    });
    if (existing) {
      const demoCodes: readonly string[] = DEMO_OUTLET_CODES;
      const foreign = existing.memberships.some((row) => !demoCodes.includes(row.outlet.code));
      if (existing.role !== Role.OUTLET_STAFF || foreign) {
        throw new Error(
          `${member.email} belongs to a non-demo account; choose another demo address.`,
        );
      }
      staffIds.set(member.email, existing.id);
      if (ROTATE) {
        const password = newPassword();
        await staffService.resetPassword(existing.id, password);
        remember({ email: member.email, password, outlets: member.outlets });
      }
    } else {
      const password = newPassword();
      const created = await staffService.create({
        email: member.email,
        password,
        outletIds: wanted,
      });
      staffIds.set(member.email, created.id);
      remember({ email: member.email, password, outlets: member.outlets });
      log(`Created staff ${member.email}`);
    }
  }

  const setMemberships = async (withBanani: boolean): Promise<void> => {
    for (const member of STAFF) {
      const ids = member.outlets.map((key) => outletIds[key]);
      if (withBanani && member.email === BANANI_CASHIER) ids.push(outletIds.BANANI);
      const id = staffIds.get(member.email) ?? '';
      const current = (
        await db.outletMembership.findMany({ where: { userId: id }, select: { outletId: true } })
      )
        .map((row) => row.outletId)
        .sort();
      if (current.join() !== [...ids].sort().join()) await staffService.replaceOutlets(id, ids);
    }
  };
  await setMemberships(!bananiDone);

  const existingSales = new Map(
    (
      await db.sale.findMany({
        where: { requestId: { in: plan.map((sale) => sale.requestId) } },
        select: { id: true, requestId: true, createdAt: true },
      })
    ).map((row) => [row.requestId, row]),
  );
  const users = new Map(
    (
      await db.user.findMany({
        where: { id: { in: [...staffIds.values()] } },
        select: { id: true, email: true, role: true },
      })
    ).map((user): [string, AuthenticatedUser] => [user.email, user]),
  );

  let created = 0;
  let skipped = 0;
  let retimed = 0;
  for (const sale of plan) {
    const existing = existingSales.get(sale.requestId);
    if (existing) {
      skipped += 1;
      if (existing.createdAt.getTime() !== sale.at.getTime()) {
        await db.sale.update({ where: { id: existing.id }, data: { createdAt: sale.at } });
        retimed += 1;
      }
      continue;
    }
    if (sale.outlet === 'BANANI' && bananiDone) {
      throw new Error('Banani is already inactive but planned historical sales are missing.');
    }
    const cashier = users.get(sale.cashier);
    if (!cashier) throw new Error(`Missing demo cashier ${sale.cashier}`);
    const result = await saleService.create(cashier, outletIds[sale.outlet], {
      requestId: sale.requestId,
      items: sale.lines.map((line) => ({
        menuItemId: idOf(line.sku),
        quantity: line.quantity,
        expectedUnitPrice: priceOf(sale.outlet, line.sku),
      })),
    });
    if (!result.replayed) {
      await db.sale.update({
        where: { id: result.sale.id, requestId: sale.requestId },
        data: { createdAt: sale.at },
      });
      created += 1;
    }
    if (created > 0 && created % 50 === 0) log(`  ${created} demo sales created…`);
  }
  log(`Demo sales: ${created} created, ${skipped} already present, ${retimed} timestamps restored`);

  for (const [outlet, skus] of Object.entries(INACTIVE_ASSIGNMENTS) as [OutletKey, string[]][]) {
    for (const sku of skus) {
      const row = await db.outletMenuItem.findUnique({
        where: { outletId_menuItemId: { outletId: outletIds[outlet], menuItemId: idOf(sku) } },
      });
      if (row?.isActive)
        await outletMenuService.setStatus(admin, outletIds[outlet], idOf(sku), false);
    }
  }
  for (const item of ITEMS.filter((entry) => entry.retired)) {
    const row = await db.menuItem.findUniqueOrThrow({ where: { id: idOf(item.sku) } });
    if (row.isActive) await menuService.setStatus(row.id, false);
  }

  if (!bananiDone) {
    const planned = plan.filter((sale) => sale.outlet === 'BANANI').length;
    const recorded = await db.sale.count({ where: { outletId: outletIds.BANANI } });
    if (recorded < planned)
      throw new Error(`Banani has ${recorded}/${planned} planned sales; not deactivating.`);
    await setMemberships(false);
    await outletService.setStatus(outletIds.BANANI, false);
    log('Banani historical sales complete; outlet deactivated');
  }

  if (credentials.length) {
    log('\nNew demo credentials (shown once; store them privately):');
    for (const entry of credentials)
      log(`  ${entry.email}  ${entry.password}  [${entry.outlets.join(', ')}]`);
    if (CREDENTIALS_FILE) {
      writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2), { mode: 0o600 });
      chmodSync(CREDENTIALS_FILE, 0o600);
      log(`Credentials also written to ${CREDENTIALS_FILE}`);
    }
  } else {
    log(
      '\nNo passwords changed. Existing demo passwords are preserved; run with --rotate-demo-passwords to issue new ones.',
    );
  }
}

try {
  await main();
} finally {
  await db.$disconnect();
}
