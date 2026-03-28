// ═══════════════════════════════════════════════════════════════
// US Stock Universe — Phase 3
// 105 stocks across 17 categories
// Base returns and sigma are calculated weekly from real price
// history by weeklyRecalibration.js — NOT hardcoded here
// This file only stores static metadata
// ═══════════════════════════════════════════════════════════════

const US_UNIVERSE = {
  // ── MAG 7 ──────────────────────────────────────────────────
  NVDA:  { name:'Nvidia',              sector:'AI Semiconductors',     rc:'US_SEMI',      dv:0.0, tags:['AI COMPUTE #1','DATA CENTER','BLACKWELL GPU'] },
  MSFT:  { name:'Microsoft',           sector:'Cloud AI Platform',      rc:'US_MEGA',      dv:1.0, tags:['AZURE AI','OPENAI PARTNER','$80B CAPEX'] },
  AAPL:  { name:'Apple',               sector:'Consumer Tech',          rc:'US_MEGA',      dv:0.5, tags:['$3T MARKET CAP','IPHONE CYCLE','SERVICES'] },
  GOOGL: { name:'Alphabet',            sector:'AI Search Cloud',        rc:'US_MEGA',      dv:0.0, tags:['GEMINI AI','YOUTUBE','GOOGLE CLOUD'] },
  META:  { name:'Meta Platforms',      sector:'AI Social Media',        rc:'US_MEGA',      dv:0.5, tags:['$65B AI CAPEX','LLAMA','3B USERS'] },
  AMZN:  { name:'Amazon',              sector:'Cloud Commerce',         rc:'US_MEGA',      dv:0.0, tags:['AWS #1 CLOUD','PRIME','BEDROCK AI'] },
  TSLA:  { name:'Tesla',               sector:'EV Autonomous',          rc:'US_GROWTH',    dv:0.0, tags:['FSD ROBOTAXI','OPTIMUS ROBOT','HIGH BETA'] },

  // ── SEMICONDUCTORS ─────────────────────────────────────────
  AMD:   { name:'Advanced Micro Devices', sector:'AI Semiconductors',  rc:'US_SEMI',      dv:0.0, tags:['MI300X GPU','NVDA RIVAL','DATA CENTER'] },
  AVGO:  { name:'Broadcom',            sector:'AI Networking Chips',    rc:'US_SEMI',      dv:1.5, tags:['AI NETWORKING','CUSTOM CHIPS','VMWARE'] },
  INTC:  { name:'Intel',               sector:'Semiconductors',         rc:'US_SEMI',      dv:2.0, tags:['TURNAROUND','FOUNDRY','X86'] },
  QCOM:  { name:'Qualcomm',            sector:'Mobile Semiconductors',  rc:'US_SEMI',      dv:2.2, tags:['SNAPDRAGON','IOT','AI EDGE'] },
  MU:    { name:'Micron Technology',   sector:'Memory Semiconductors',  rc:'US_SEMI',      dv:0.4, tags:['HBM MEMORY','AI DEMAND','DRAM'] },
  AMAT:  { name:'Applied Materials',   sector:'Semiconductor Equipment',rc:'US_SEMI',      dv:1.0, tags:['CHIP EQUIPMENT','AI CAPEX PLAY','MOAT'] },
  LRCX:  { name:'Lam Research',        sector:'Semiconductor Equipment',rc:'US_SEMI',      dv:1.2, tags:['ETCH EQUIPMENT','AI CAPEX','MOAT'] },
  ASML:  { name:'ASML Holding',        sector:'Chip Lithography',       rc:'US_SEMI',      dv:0.9, tags:['EUV MONOPOLY','AI ENABLER','DUTCH ADR'] },
  TSM:   { name:'TSMC ADR',            sector:'Semiconductor Foundry',  rc:'US_SEMI',      dv:1.8, tags:['NVIDIA PARTNER','2NM NODE','TAIWAN RISK'] },
  ARM:   { name:'Arm Holdings',        sector:'Chip Architecture IP',   rc:'US_SEMI',      dv:0.0, tags:['CPU IP MONOPOLY','AI EDGE','MOBILE'] },
  MRVL:  { name:'Marvell Technology',  sector:'AI Data Center Chips',   rc:'US_SEMI',      dv:0.4, tags:['CUSTOM AI CHIPS','DATA CENTER','5G'] },

  // ── CLOUD / SAAS ────────────────────────────────────────────
  CRM:   { name:'Salesforce',          sector:'Enterprise SaaS',        rc:'US_SAAS',      dv:0.6, tags:['AI CRM','AGENTFORCE','ENTERPRISE'] },
  NOW:   { name:'ServiceNow',          sector:'Enterprise AI SaaS',     rc:'US_SAAS',      dv:0.0, tags:['AI WORKFLOWS','ENTERPRISE','HIGH GROWTH'] },
  SNOW:  { name:'Snowflake',           sector:'Data Cloud',             rc:'US_SAAS',      dv:0.0, tags:['DATA CLOUD','AI WORKLOADS','HIGH BURN'] },
  DDOG:  { name:'Datadog',             sector:'AI Observability',       rc:'US_SAAS',      dv:0.0, tags:['AI MONITORING','USAGE BASED','DEVOPS'] },
  NET:   { name:'Cloudflare',          sector:'Edge AI Network',        rc:'US_SAAS',      dv:0.0, tags:['YOU HOLD $208.62','EDGE AI','ZERO TRUST'], yourPos:{ qty:1.066992, avg:208.62 } },
  PANW:  { name:'Palo Alto Networks',  sector:'Cybersecurity',          rc:'US_SAAS',      dv:0.0, tags:['AI SECURITY','PLATFORMIZATION','SASE'] },
  ZS:    { name:'Zscaler',             sector:'Cloud Security',         rc:'US_SAAS',      dv:0.0, tags:['ZERO TRUST','CLOUD SECURITY','HIGH GROWTH'] },
  PLTR:  { name:'Palantir',            sector:'AI Analytics Defence',   rc:'US_SAAS',      dv:0.0, tags:['AIP PLATFORM','DEFENCE AI','HIGH VALUATION'] },
  ADBE:  { name:'Adobe',               sector:'Creative AI SaaS',       rc:'US_SAAS',      dv:0.0, tags:['FIREFLY AI','CREATIVE CLOUD','AI DISRUPTION RISK'] },
  ORCL:  { name:'Oracle',              sector:'Cloud Database',         rc:'US_SAAS',      dv:1.3, tags:['AI CLOUD INFRA','DATABASE','OCI GROWTH'] },
  WDAY:  { name:'Workday',             sector:'HR Finance SaaS',        rc:'US_SAAS',      dv:0.0, tags:['AI HR','ENTERPRISE','STICKY REVENUE'] },
  INTU:  { name:'Intuit',              sector:'Financial SaaS',         rc:'US_SAAS',      dv:0.7, tags:['TURBOTAX','QUICKBOOKS','SMB AI'] },

  // ── ENERGY ─────────────────────────────────────────────────
  CEG:   { name:'Constellation Energy', sector:'Nuclear Power',         rc:'US_POWER',     dv:0.5, tags:['YOU HOLD $310.43','AI DATA CENTER POWER','NUCLEAR'], yourPos:{ qty:0.714253, avg:310.43 } },
  GLNG:  { name:'Golar LNG',           sector:'LNG Infrastructure FLNG',rc:'US_ENERGY',    dv:2.1, tags:['YOU HOLD $50.93','IRAN WAR DIRECT PLAY','FLNG'], yourPos:{ qty:3.489692, avg:50.93 } },
  LNG:   { name:'Cheniere Energy',     sector:'LNG Export USA',         rc:'US_ENERGY',    dv:1.2, tags:['GLNG COMPETITOR','US LNG EXPORT','IRAN PLAY'] },
  XOM:   { name:'Exxon Mobil',         sector:'Integrated Oil Gas',     rc:'US_ENERGY',    dv:3.5, tags:['OIL MAJOR','$100 OIL BENEFICIARY','DIVIDEND'] },
  CVX:   { name:'Chevron',             sector:'Integrated Oil Gas',     rc:'US_ENERGY',    dv:4.0, tags:['OIL MAJOR','LNG ASSETS','DIVIDEND'] },
  COP:   { name:'ConocoPhillips',      sector:'E&P Oil',                rc:'US_ENERGY',    dv:1.8, tags:['E&P PURE PLAY','OIL $100','BUYBACKS'] },
  SLB:   { name:'SLB Schlumberger',    sector:'Oil Services',           rc:'US_ENERGY',    dv:2.5, tags:['OIL SERVICES','GLOBAL DRILLING','IRAN BENEFICIARY'] },
  NEE:   { name:'NextEra Energy',      sector:'Renewable Power',        rc:'US_POWER',     dv:2.8, tags:['WIND SOLAR LEADER','AI DATA CENTER','RATE SENSITIVE'] },
  VST:   { name:'Vistra Energy',       sector:'Nuclear Gas Power',      rc:'US_POWER',     dv:0.8, tags:['NUCLEAR AI POWER','CEG PEER','DATA CENTER'] },
  TTE:   { name:'TotalEnergies ADR',   sector:'Integrated Oil LNG',     rc:'US_ENERGY',    dv:5.2, tags:['FLNG OPERATOR','GLNG PEER','OIL+LNG'] },
  SHEL:  { name:'Shell ADR',           sector:'Integrated Oil LNG',     rc:'US_ENERGY',    dv:4.1, tags:['FLNG PRELUDE','GLNG PEER','LNG MAJOR'] },
  BP:    { name:'BP ADR',              sector:'Integrated Oil',         rc:'US_ENERGY',    dv:4.8, tags:['OIL MAJOR','ENERGY TRANSITION','UK ADR'] },
  FANG:  { name:'Diamondback Energy',  sector:'Shale Oil',              rc:'US_ENERGY',    dv:4.5, tags:['PERMIAN PURE PLAY','$100 OIL','BUYBACKS'] },

  // ── FINANCIALS ─────────────────────────────────────────────
  JPM:   { name:'JPMorgan Chase',      sector:'Investment Banking',     rc:'US_FIN',       dv:2.3, tags:['GLOBAL BANK #1','AI FINANCE','FED HOLD BENEFICIARY'] },
  GS:    { name:'Goldman Sachs',       sector:'Investment Banking',     rc:'US_FIN',       dv:2.5, tags:['WALL STREET','M&A RECOVERY','AI TRADING'] },
  MS:    { name:'Morgan Stanley',      sector:'Wealth Management',      rc:'US_FIN',       dv:3.1, tags:['WEALTH MGMT','E*TRADE','RATE BENEFICIARY'] },
  BAC:   { name:'Bank of America',     sector:'Retail Banking',         rc:'US_FIN',       dv:2.4, tags:['RATE SENSITIVE','CONSUMER BANK','FED HOLD'] },
  V:     { name:'Visa',                sector:'Payment Networks',       rc:'US_FIN',       dv:0.8, tags:['PAYMENT MOAT','INDIA EXPANSION','AI FRAUD'] },
  MA:    { name:'Mastercard',          sector:'Payment Networks',       rc:'US_FIN',       dv:0.6, tags:['PAYMENT MOAT','CROSS BORDER','INDIA UPI RIVAL'] },
  BRKB:  { name:'Berkshire Hathaway B',sector:'Diversified Holdings',  rc:'US_FIN',       dv:0.0, tags:['BUFFETT','$334B CASH','DEFENSIVE'] },
  BLK:   { name:'BlackRock',           sector:'Asset Management',       rc:'US_FIN',       dv:2.7, tags:['$10T AUM','ETF DOMINANCE','ALADDIN AI'] },
  SPGI:  { name:'S&P Global',          sector:'Financial Data',         rc:'US_FIN',       dv:0.9, tags:['RATINGS MOAT','DATA AI','INDICES'] },
  COF:   { name:'Capital One',         sector:'Consumer Credit',        rc:'US_FIN',       dv:1.8, tags:['CREDIT CARDS','DISCOVER MERGER','AI CREDIT'] },

  // ── HEALTHCARE ─────────────────────────────────────────────
  LLY:   { name:'Eli Lilly',           sector:'GLP-1 Pharma',           rc:'US_HEALTH',    dv:0.7, tags:['OZEMPIC RIVAL MOUNJARO','WEIGHT LOSS BOOM','PIPELINE'] },
  NVO:   { name:'Novo Nordisk ADR',    sector:'GLP-1 Pharma',           rc:'US_HEALTH',    dv:1.1, tags:['OZEMPIC MAKER','GLP-1 LEADER','DANISH ADR'] },
  JNJ:   { name:'Johnson & Johnson',   sector:'Diversified Healthcare',  rc:'US_HEALTH',   dv:3.2, tags:['MEDTECH PHARMA','DEFENSIVE','DIVIDEND KING'] },
  UNH:   { name:'UnitedHealth',        sector:'Health Insurance',       rc:'US_HEALTH',    dv:1.5, tags:['HEALTH INSURANCE #1','AI CLAIMS','OPTUM'] },
  ABBV:  { name:'AbbVie',              sector:'Specialty Pharma',       rc:'US_HEALTH',    dv:3.8, tags:['HUMIRA SUCCESSOR','SKYRIZI','HIGH DIVIDEND'] },
  MRK:   { name:'Merck',               sector:'Pharma Oncology',        rc:'US_HEALTH',    dv:2.6, tags:['KEYTRUDA CANCER','VACCINES','PIPELINE'] },
  PFE:   { name:'Pfizer',              sector:'Pharma',                 rc:'US_HEALTH',    dv:6.5, tags:['POST-COVID RECOVERY','PIPELINE','HIGH YIELD'] },
  TMO:   { name:'Thermo Fisher',       sector:'Life Sciences Tools',    rc:'US_HEALTH',    dv:0.3, tags:['LAB EQUIPMENT','AI DRUG DISCOVERY','B2B'] },
  ISRG:  { name:'Intuitive Surgical',  sector:'Surgical Robotics',      rc:'US_HEALTH',    dv:0.0, tags:['DA VINCI ROBOT','SURGERY AI','MOAT'] },

  // ── CONSUMER ───────────────────────────────────────────────
  WMT:   { name:'Walmart',             sector:'Defensive Retail',       rc:'US_CONSUMER',  dv:1.2, tags:['DEFENSIVE RETAIL','INDIA FLIPKART','AI SUPPLY CHAIN'] },
  COST:  { name:'Costco',              sector:'Warehouse Retail',       rc:'US_CONSUMER',  dv:0.7, tags:['MEMBERSHIP MOAT','INFLATION RESILIENT','PREMIUM'] },
  MCD:   { name:'McDonald\'s',         sector:'Fast Food',              rc:'US_CONSUMER',  dv:2.4, tags:['GLOBAL BRAND','AI ORDERING','DEFENSIVE'] },
  NKE:   { name:'Nike',                sector:'Athletic Apparel',       rc:'US_CONSUMER',  dv:2.0, tags:['INDIA GROWTH','DIRECT TO CONSUMER','TURNAROUND'] },
  SBUX:  { name:'Starbucks',           sector:'Coffee Retail',          rc:'US_CONSUMER',  dv:2.8, tags:['CHINA RECOVERY','INDIA EXPANSION','TURNAROUND'] },
  DIS:   { name:'Walt Disney',         sector:'Entertainment Media',    rc:'US_CONSUMER',  dv:0.7, tags:['STREAMING WAR','PARKS RECOVERY','IP MOAT'] },
  NFLX:  { name:'Netflix',             sector:'Streaming',              rc:'US_CONSUMER',  dv:0.0, tags:['AD TIER GROWTH','AI CONTENT','INDIA MARKET'] },

  // ── DEFENCE ────────────────────────────────────────────────
  LMT:   { name:'Lockheed Martin',     sector:'US Defence Aerospace',   rc:'US_DEFENCE',   dv:2.8, tags:['F-35 FIGHTER','IRAN WAR PLAY','NATO SPENDING'] },
  RTX:   { name:'RTX Raytheon',        sector:'US Defence Missiles',    rc:'US_DEFENCE',   dv:2.1, tags:['PATRIOT MISSILES','IRAN WAR','UKRAINE DEMAND'] },
  NOC:   { name:'Northrop Grumman',    sector:'US Defence Space',       rc:'US_DEFENCE',   dv:1.7, tags:['B-21 BOMBER','SPACE DEFENCE','IRAN WAR'] },
  GD:    { name:'General Dynamics',    sector:'US Defence IT',          rc:'US_DEFENCE',   dv:2.0, tags:['GULFSTREAM JETS','DEFENCE IT','CYBER'] },
  HII:   { name:'Huntington Ingalls',  sector:'US Navy Shipbuilding',   rc:'US_DEFENCE',   dv:2.1, tags:['NAVY SHIPS','IRAN WAR','COCHIN SHIP US PEER'] },

  // ── INDUSTRIALS ────────────────────────────────────────────
  GE:    { name:'GE Aerospace',        sector:'Jet Engines',            rc:'US_INDUSTRIAL', dv:0.3, tags:['JET ENGINE DUOPOLY','SERVICES','AI MAINTENANCE'] },
  CAT:   { name:'Caterpillar',         sector:'Heavy Machinery',        rc:'US_INDUSTRIAL', dv:1.6, tags:['INFRASTRUCTURE','MINING','INDIA GROWTH'] },
  HON:   { name:'Honeywell',           sector:'Industrial Conglomerate', rc:'US_INDUSTRIAL',dv:2.0, tags:['AI AUTOMATION','INDUSTRIAL IOT','DEFENCE'] },
  UPS:   { name:'UPS',                 sector:'Logistics',              rc:'US_INDUSTRIAL', dv:4.8, tags:['ECOMMERCE BACKBONE','AI ROUTING','AMAZON RIVAL'] },
  FDX:   { name:'FedEx',               sector:'Logistics',              rc:'US_INDUSTRIAL', dv:2.0, tags:['FREIGHT RECOVERY','AI EFFICIENCY','GLOBAL'] },

  // ── REAL ESTATE / DATA CENTERS ────────────────────────────
  AMT:   { name:'American Tower',      sector:'Telecom REIT',           rc:'US_REIT',       dv:3.2, tags:['INDIA TOWERS','5G PLAY','RATE SENSITIVE'] },
  PLD:   { name:'Prologis',            sector:'Industrial REIT',        rc:'US_REIT',       dv:2.8, tags:['ECOMMERCE WAREHOUSES','AI DATA CENTER LAND','LOGISTICS'] },
  EQIX:  { name:'Equinix',             sector:'Data Center REIT',       rc:'US_REIT',       dv:2.1, tags:['DATA CENTER LANDLORD','AI DEMAND','GLOBAL'] },
  O:     { name:'Realty Income',       sector:'Net Lease REIT',         rc:'US_REIT',       dv:5.6, tags:['MONTHLY DIVIDEND','DEFENSIVE','RATE SENSITIVE'] },
  DLR:   { name:'Digital Realty',      sector:'Data Center REIT',       rc:'US_REIT',       dv:3.0, tags:['AI DATA CENTER','HYPERSCALER TENANT','GLOBAL'] },

  // ── COMMODITIES / MATERIALS ───────────────────────────────
  GLD:   { name:'SPDR Gold ETF',       sector:'Gold ETF',               rc:'US_GOLD',       dv:0.0, tags:['SAFE HAVEN','IRAN WAR PLAY','FED HOLD'] },
  SLV:   { name:'Silver ETF iShares',  sector:'Silver ETF',             rc:'US_GOLD',       dv:0.0, tags:['INDUSTRIAL METAL','SOLAR PANELS','SAFE HAVEN'] },
  NEM:   { name:'Newmont Corporation', sector:'Gold Mining',            rc:'US_GOLD',       dv:2.5, tags:['GOLD MINER','LEVERAGED GOLD','OPERATIONAL RISK'] },
  FCX:   { name:'Freeport-McMoRan',    sector:'Copper Mining',          rc:'US_MATERIALS',  dv:1.5, tags:['COPPER #1','EV DEMAND','AI INFRASTRUCTURE'] },
  LIN:   { name:'Linde',               sector:'Industrial Gases',       rc:'US_MATERIALS',  dv:1.3, tags:['HYDROGEN ECONOMY','SEMICONDUCTOR GASES','MOAT'] },

  // ── ETFs ────────────────────────────────────────────────────
  SPY:   { name:'S&P 500 SPDR ETF',    sector:'US Broad Market ETF',    rc:'US_ETF',        dv:1.3, tags:['500 LARGEST US','BENCHMARK','PASSIVE'] },
  QQQ:   { name:'Nasdaq 100 ETF',      sector:'US Tech Heavy ETF',      rc:'US_ETF',        dv:0.5, tags:['TECH HEAVY','AI ECOSYSTEM','HIGH BETA'] },
  VOO:   { name:'Vanguard S&P 500',    sector:'US Broad Market ETF',    rc:'US_ETF',        dv:1.4, tags:['LOW COST 0.03%','BUFFETT PICK','PASSIVE'] },
  SOXX:  { name:'Semiconductor ETF',   sector:'Semiconductor ETF',      rc:'US_ETF',        dv:0.8, tags:['AI CHIP BASKET','NVDA+AMD+AVGO','HIGH BETA'] },
  XLE:   { name:'Energy Select ETF',   sector:'US Energy ETF',          rc:'US_ETF',        dv:3.5, tags:['OIL GAS BASKET','IRAN PLAY','XOM+CVX+COP'] },
  XLF:   { name:'Financial Select ETF',sector:'US Financial ETF',       rc:'US_ETF',        dv:1.8, tags:['BANK BASKET','FED RATE PLAY','JPM+BAC'] },
  ARKK:  { name:'ARK Innovation ETF',  sector:'Disruptive Tech ETF',    rc:'US_ETF',        dv:0.0, tags:['HIGH RISK HIGH REWARD','TSLA HEAVY','CATHIE WOOD'] },
  EEM:   { name:'iShares Emerging Markets ETF', sector:'EM ETF',        rc:'US_ETF',        dv:2.1, tags:['INDIA+CHINA+EM','FII PROXY','DOLLAR SENSITIVE'] },
  INDA:  { name:'iShares MSCI India ETF', sector:'India ETF',           rc:'US_ETF',        dv:0.3, tags:['INDIA NIFTY PROXY','FII FLOWS','NSE TRACKER'] },

  // ── INDIA ADRs ─────────────────────────────────────────────
  INFY:  { name:'Infosys ADR',         sector:'India IT ADR',           rc:'US_INDIA_ADR',  dv:2.8, tags:['NSE:INFY','USD EARNER','AI SERVICES'] },
  WIT:   { name:'Wipro ADR',           sector:'India IT ADR',           rc:'US_INDIA_ADR',  dv:0.2, tags:['NSE:WIPRO','USD EARNER','TURNAROUND'] },
  HDB:   { name:'HDFC Bank ADR',       sector:'India Bank ADR',         rc:'US_INDIA_ADR',  dv:1.2, tags:['NSE:HDFCBANK','INDIA CONSUMER','ADR PREMIUM'] },
  IBN:   { name:'ICICI Bank ADR',      sector:'India Bank ADR',         rc:'US_INDIA_ADR',  dv:0.8, tags:['NSE:ICICIBANK','INDIA CONSUMER','ADR PREMIUM'] },
  RDY:   { name:'Dr Reddys ADR',       sector:'India Pharma ADR',       rc:'US_INDIA_ADR',  dv:0.6, tags:['NSE:DRREDDY','US FDA PLAY','GENERICS'] },
  VEDL:  { name:'Vedanta ADR',         sector:'India Mining ADR',       rc:'US_INDIA_ADR',  dv:8.5, tags:['NSE:VEDL','ZINC COPPER','HIGH YIELD'] },
};

// ── SECTOR COLORS ─────────────────────────────────────────────
const US_SECTOR_COLORS = {
  US_MEGA:      '#00d4aa',
  US_SEMI:      '#4f8ef7',
  US_SAAS:      '#ff6b35',
  US_ENERGY:    '#ffa726',
  US_POWER:     '#fbbf24',
  US_FIN:       '#00c8e0',
  US_HEALTH:    '#a78bfa',
  US_CONSUMER:  '#f472b6',
  US_DEFENCE:   '#00d4aa',
  US_INDUSTRIAL:'#7a90b8',
  US_REIT:      '#9b59ff',
  US_GOLD:      '#ffa726',
  US_MATERIALS: '#4f8ef7',
  US_ETF:       '#3a4d6e',
  US_INDIA_ADR: '#ff9933',
  US_GROWTH:    '#ff4757',
};

// ── YAHOO FINANCE SYMBOLS for price fetching ──────────────────
// Maps our symbol to Yahoo Finance symbol (most are same)
const YAHOO_SYMBOL_MAP = {
  BRKB:  'BRK-B',
  GOOGL: 'GOOGL',
  // All others use symbol directly
};

function getYahooSymbol(symbol) {
  return YAHOO_SYMBOL_MAP[symbol] || symbol;
}

// ── GET ALL US SYMBOLS ─────────────────────────────────────────
function getAllUSSymbols() {
  return Object.keys(US_UNIVERSE);
}

// ── GET YOUR HOLDINGS ─────────────────────────────────────────
function getYourHoldings() {
  return Object.entries(US_UNIVERSE)
    .filter(([, v]) => v.yourPos)
    .map(([symbol, v]) => ({ symbol, ...v }));
}

// ── GET BY CATEGORY ───────────────────────────────────────────
function getByCategory(rc) {
  return Object.entries(US_UNIVERSE)
    .filter(([, v]) => v.rc === rc)
    .map(([symbol, v]) => ({ symbol, ...v }));
}

module.exports = {
  US_UNIVERSE,
  US_SECTOR_COLORS,
  getAllUSSymbols,
  getYahooSymbol,
  getYourHoldings,
  getByCategory,
};
