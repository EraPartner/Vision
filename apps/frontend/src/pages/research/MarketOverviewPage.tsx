import { useMemo, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Globe, Star } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useLanguage } from "@/contexts/LanguageContext";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { useInvestmentsQuery } from "@/hooks/portfolio/useInvestments";
import { apiClient } from "@/lib/api";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/shared/PageHeader";

// The overview crosses two orthogonal axes: a Region (Worldwide / USA / Europe /
// Asia / Japan / Latin America) and a Sector (Overview + themed baskets). Region
// is the global axis — when the Sector is "Overview" we show that region's
// Indices + Top stocks; otherwise we show the sector's basket filtered to the
// region. Worldwide shows every member; a region shows only members tagged with
// it (members that fit no region — Canadian, Saudi, Australian names — are
// worldwide-only and carry no `region` tag). Japan is split out of the broader
// Asia bucket and Latin America is its own region. Yahoo is keyless/unmetered
// and has no universe-scan API, so membership is a static config baked in here.
// A symbol Yahoo can't quote (coverage drifts by IP/geo) degrades to a neutral
// em-dash tile. Cards for symbols the user actually holds get an accent ring +
// star (gold in the default theme, theme-accent elsewhere).
type Region = "worldwide" | "usa" | "europe" | "asia" | "japan" | "latam";

interface SymbolEntry {
  symbol: string;
  label: string;
  // Sector entries only: the region this name is grouped under. Omitted = the
  // name fits none of usa/europe/asia and is shown only in the Worldwide view.
  region?: Exclude<Region, "worldwide">;
}

interface ViewGroup {
  titleKey?: string;
  entries: ReadonlyArray<SymbolEntry>;
}

interface MarketView {
  key: string;
  labelKey: string;
  groups: ReadonlyArray<ViewGroup>;
}

const REGION_VIEWS: ReadonlyArray<MarketView> = [
  {
    key: "worldwide",
    labelKey: "research.markets.region.worldwide",
    groups: [
      {
        titleKey: "research.markets.indices",
        entries: [
          { symbol: "^GSPC", label: "S&P 500" },
          { symbol: "^IXIC", label: "Nasdaq" },
          { symbol: "^DJI", label: "Dow Jones" },
          { symbol: "^STOXX50E", label: "Euro Stoxx 50" },
          { symbol: "^FTSE", label: "FTSE 100" },
          { symbol: "^GDAXI", label: "DAX" },
          { symbol: "^FCHI", label: "CAC 40" },
          { symbol: "^N225", label: "Nikkei 225" },
          { symbol: "^HSI", label: "Hang Seng" },
          { symbol: "000001.SS", label: "Shanghai" },
          { symbol: "^BSESN", label: "Sensex" },
          { symbol: "^GSPTSE", label: "TSX" },
          { symbol: "^BVSP", label: "Bovespa" },
          { symbol: "^AXJO", label: "ASX 200" },
        ],
      },
      {
        titleKey: "research.markets.stocks",
        entries: [
          { symbol: "AAPL", label: "Apple" },
          { symbol: "MSFT", label: "Microsoft" },
          { symbol: "NVDA", label: "Nvidia" },
          { symbol: "GOOGL", label: "Alphabet" },
          { symbol: "AMZN", label: "Amazon" },
          { symbol: "META", label: "Meta" },
          { symbol: "AVGO", label: "Broadcom" },
          { symbol: "BRK-B", label: "Berkshire Hathaway" },
          { symbol: "LLY", label: "Eli Lilly" },
          { symbol: "TSM", label: "TSMC" },
          { symbol: "2222.SR", label: "Saudi Aramco" },
          { symbol: "ASML.AS", label: "ASML" },
          { symbol: "NVO", label: "Novo Nordisk" },
          { symbol: "MC.PA", label: "LVMH" },
          { symbol: "NESN.SW", label: "Nestlé" },
          { symbol: "005930.KS", label: "Samsung" },
          { symbol: "TM", label: "Toyota" },
          { symbol: "0700.HK", label: "Tencent" },
          { symbol: "BTC-USD", label: "Bitcoin" },
          { symbol: "ETH-USD", label: "Ethereum" },
        ],
      },
    ],
  },
  {
    key: "usa",
    labelKey: "research.markets.region.usa",
    groups: [
      {
        titleKey: "research.markets.indices",
        entries: [
          { symbol: "^GSPC", label: "S&P 500" },
          { symbol: "^IXIC", label: "Nasdaq" },
          { symbol: "^NDX", label: "Nasdaq 100" },
          { symbol: "^DJI", label: "Dow Jones" },
          { symbol: "^RUT", label: "Russell 2000" },
          { symbol: "^VIX", label: "VIX" },
        ],
      },
      {
        titleKey: "research.markets.stocks",
        entries: [
          { symbol: "AAPL", label: "Apple" },
          { symbol: "MSFT", label: "Microsoft" },
          { symbol: "NVDA", label: "Nvidia" },
          { symbol: "AMZN", label: "Amazon" },
          { symbol: "GOOGL", label: "Alphabet" },
          { symbol: "META", label: "Meta" },
          { symbol: "AVGO", label: "Broadcom" },
          { symbol: "TSLA", label: "Tesla" },
          { symbol: "BRK-B", label: "Berkshire Hathaway" },
          { symbol: "LLY", label: "Eli Lilly" },
          { symbol: "JPM", label: "JPMorgan" },
          { symbol: "V", label: "Visa" },
          { symbol: "MA", label: "Mastercard" },
          { symbol: "UNH", label: "UnitedHealth" },
          { symbol: "XOM", label: "Exxon Mobil" },
          { symbol: "JNJ", label: "Johnson & Johnson" },
          { symbol: "WMT", label: "Walmart" },
          { symbol: "PG", label: "Procter & Gamble" },
          { symbol: "ORCL", label: "Oracle" },
          { symbol: "COST", label: "Costco" },
          { symbol: "HD", label: "Home Depot" },
          { symbol: "KO", label: "Coca-Cola" },
          { symbol: "BAC", label: "Bank of America" },
          { symbol: "ABBV", label: "AbbVie" },
          { symbol: "CVX", label: "Chevron" },
          { symbol: "HAL", label: "Halliburton" },
          { symbol: "NFLX", label: "Netflix" },
          { symbol: "AMD", label: "AMD" },
          { symbol: "CRM", label: "Salesforce" },
          { symbol: "ADBE", label: "Adobe" },
          { symbol: "MCD", label: "McDonald's" },
        ],
      },
    ],
  },
  {
    key: "europe",
    labelKey: "research.markets.region.europe",
    groups: [
      {
        titleKey: "research.markets.indices",
        entries: [
          { symbol: "^STOXX50E", label: "Euro Stoxx 50" },
          { symbol: "^FTSE", label: "FTSE 100" },
          { symbol: "^GDAXI", label: "DAX" },
          { symbol: "^FCHI", label: "CAC 40" },
          { symbol: "^BFX", label: "BEL 20" },
          { symbol: "^IBEX", label: "IBEX 35" },
          { symbol: "^AEX", label: "AEX" },
          { symbol: "^SSMI", label: "SMI" },
          { symbol: "FTSEMIB.MI", label: "FTSE MIB" },
          { symbol: "^OMX", label: "OMX 30" },
          { symbol: "PSI20.LS", label: "PSI 20" },
        ],
      },
      {
        titleKey: "research.markets.stocks",
        entries: [
          { symbol: "ASML.AS", label: "ASML" },
          { symbol: "MC.PA", label: "LVMH" },
          { symbol: "NESN.SW", label: "Nestlé" },
          { symbol: "NOVN.SW", label: "Novartis" },
          { symbol: "RO.SW", label: "Roche" },
          { symbol: "SAP.DE", label: "SAP" },
          { symbol: "NOVO-B.CO", label: "Novo Nordisk" },
          { symbol: "SHEL.L", label: "Shell" },
          { symbol: "AZN.L", label: "AstraZeneca" },
          { symbol: "ULVR.L", label: "Unilever" },
          { symbol: "HSBA.L", label: "HSBC" },
          { symbol: "SIE.DE", label: "Siemens" },
          { symbol: "ALV.DE", label: "Allianz" },
          { symbol: "DTE.DE", label: "Deutsche Telekom" },
          { symbol: "ABI.BR", label: "AB InBev" },
          { symbol: "OR.PA", label: "L'Oréal" },
          { symbol: "RMS.PA", label: "Hermès" },
          { symbol: "AIR.PA", label: "Airbus" },
          { symbol: "TTE.PA", label: "TotalEnergies" },
          { symbol: "SAN.PA", label: "Sanofi" },
          { symbol: "PRX.AS", label: "Prosus" },
          { symbol: "IBE.MC", label: "Iberdrola" },
          { symbol: "ENEL.MI", label: "Enel" },
          { symbol: "RIO.L", label: "Rio Tinto" },
        ],
      },
    ],
  },
  {
    key: "asia",
    labelKey: "research.markets.region.asia",
    groups: [
      {
        titleKey: "research.markets.indices",
        entries: [
          { symbol: "^HSI", label: "Hang Seng" },
          { symbol: "000001.SS", label: "Shanghai" },
          { symbol: "399001.SZ", label: "Shenzhen" },
          { symbol: "^KS11", label: "KOSPI" },
          { symbol: "^TWII", label: "Taiwan" },
          { symbol: "^BSESN", label: "Sensex" },
          { symbol: "^NSEI", label: "Nifty 50" },
          { symbol: "^STI", label: "Straits Times" },
          { symbol: "^AXJO", label: "ASX 200" },
        ],
      },
      {
        titleKey: "research.markets.stocks",
        entries: [
          { symbol: "BABA", label: "Alibaba" },
          { symbol: "0700.HK", label: "Tencent" },
          { symbol: "9988.HK", label: "Alibaba (HK)" },
          { symbol: "3690.HK", label: "Meituan" },
          { symbol: "1810.HK", label: "Xiaomi" },
          { symbol: "1299.HK", label: "AIA" },
          { symbol: "0941.HK", label: "China Mobile" },
          { symbol: "TSM", label: "TSMC" },
          { symbol: "005930.KS", label: "Samsung" },
          { symbol: "000660.KS", label: "SK Hynix" },
          { symbol: "9618.HK", label: "JD (HK)" },
          { symbol: "BYDDY", label: "BYD" },
          { symbol: "RELIANCE.NS", label: "Reliance" },
          { symbol: "INFY", label: "Infosys" },
          { symbol: "HDB", label: "HDFC Bank" },
          { symbol: "NIO", label: "NIO" },
          { symbol: "PDD", label: "PDD" },
        ],
      },
    ],
  },
  {
    key: "japan",
    labelKey: "research.markets.region.japan",
    groups: [
      {
        titleKey: "research.markets.indices",
        entries: [
          { symbol: "^N225", label: "Nikkei 225" },
          { symbol: "1306.T", label: "TOPIX ETF" },
        ],
      },
      {
        titleKey: "research.markets.stocks",
        entries: [
          { symbol: "7203.T", label: "Toyota" },
          { symbol: "6758.T", label: "Sony" },
          { symbol: "6861.T", label: "Keyence" },
          { symbol: "8306.T", label: "Mitsubishi UFJ" },
          { symbol: "6098.T", label: "Recruit" },
          { symbol: "9984.T", label: "SoftBank Group" },
          { symbol: "9432.T", label: "NTT" },
          { symbol: "9433.T", label: "KDDI" },
          { symbol: "6501.T", label: "Hitachi" },
          { symbol: "8035.T", label: "Tokyo Electron" },
          { symbol: "4063.T", label: "Shin-Etsu Chemical" },
          { symbol: "6902.T", label: "Denso" },
          { symbol: "7974.T", label: "Nintendo" },
          { symbol: "9983.T", label: "Fast Retailing" },
          { symbol: "8058.T", label: "Mitsubishi Corp" },
          { symbol: "8001.T", label: "Itochu" },
          { symbol: "4502.T", label: "Takeda" },
          { symbol: "6954.T", label: "Fanuc" },
          { symbol: "6367.T", label: "Daikin" },
          { symbol: "7267.T", label: "Honda" },
        ],
      },
    ],
  },
  {
    key: "latam",
    labelKey: "research.markets.region.latam",
    groups: [
      {
        titleKey: "research.markets.indices",
        entries: [
          { symbol: "^BVSP", label: "Bovespa" },
          { symbol: "^MXX", label: "IPC Mexico" },
          { symbol: "^IPSA", label: "IPSA Chile" },
          { symbol: "^MERV", label: "Merval" },
        ],
      },
      {
        titleKey: "research.markets.stocks",
        entries: [
          { symbol: "VALE", label: "Vale" },
          { symbol: "PBR", label: "Petrobras" },
          { symbol: "ITUB", label: "Itaú Unibanco" },
          { symbol: "NU", label: "Nu Holdings" },
          { symbol: "MELI", label: "MercadoLibre" },
          { symbol: "ABEV", label: "Ambev" },
          { symbol: "BBD", label: "Bradesco" },
          { symbol: "BSBR", label: "Santander Brasil" },
          { symbol: "GGB", label: "Gerdau" },
          { symbol: "SBS", label: "Sabesp" },
          { symbol: "FMX", label: "FEMSA" },
          { symbol: "AMX", label: "América Móvil" },
          { symbol: "KOF", label: "Coca-Cola FEMSA" },
          { symbol: "CX", label: "Cemex" },
          { symbol: "BAP", label: "Credicorp" },
          { symbol: "SQM", label: "SQM" },
          { symbol: "BCH", label: "Banco de Chile" },
          { symbol: "EC", label: "Ecopetrol" },
          { symbol: "CIB", label: "Bancolombia" },
          { symbol: "CPA", label: "Copa Holdings" },
        ],
      },
    ],
  },
];

const SECTOR_VIEWS: ReadonlyArray<MarketView> = [
  {
    key: "semiconductors",
    labelKey: "research.markets.sector.semiconductors",
    groups: [{ entries: [
      { symbol: "SMH", label: "Semis ETF", region: "usa" },
      { symbol: "NVDA", label: "Nvidia", region: "usa" },
      { symbol: "AVGO", label: "Broadcom", region: "usa" },
      { symbol: "AMD", label: "AMD", region: "usa" },
      { symbol: "QCOM", label: "Qualcomm", region: "usa" },
      { symbol: "TXN", label: "Texas Instruments", region: "usa" },
      { symbol: "INTC", label: "Intel", region: "usa" },
      { symbol: "MU", label: "Micron", region: "usa" },
      { symbol: "AMAT", label: "Applied Materials", region: "usa" },
      { symbol: "LRCX", label: "Lam Research", region: "usa" },
      { symbol: "KLAC", label: "KLA", region: "usa" },
      { symbol: "ADI", label: "Analog Devices", region: "usa" },
      { symbol: "MRVL", label: "Marvell", region: "usa" },
      { symbol: "MCHP", label: "Microchip", region: "usa" },
      { symbol: "ASML.AS", label: "ASML", region: "europe" },
      { symbol: "ARM", label: "Arm", region: "europe" },
      { symbol: "NXPI", label: "NXP", region: "europe" },
      { symbol: "STM", label: "STMicro", region: "europe" },
      { symbol: "IFX.DE", label: "Infineon", region: "europe" },
      { symbol: "ASM.AS", label: "ASM International", region: "europe" },
      { symbol: "BESI.AS", label: "BE Semiconductor", region: "europe" },
      { symbol: "SOI.PA", label: "Soitec", region: "europe" },
      { symbol: "TSM", label: "TSMC", region: "asia" },
      { symbol: "000660.KS", label: "SK Hynix", region: "asia" },
      { symbol: "005930.KS", label: "Samsung", region: "asia" },
      { symbol: "8035.T", label: "Tokyo Electron", region: "japan" },
      { symbol: "6857.T", label: "Advantest", region: "japan" },
      { symbol: "3711.TW", label: "ASE Technology", region: "asia" },
    ] }],
  },
  {
    key: "ai",
    labelKey: "research.markets.sector.ai",
    groups: [{ entries: [
      { symbol: "NVDA", label: "Nvidia", region: "usa" },
      { symbol: "MSFT", label: "Microsoft", region: "usa" },
      { symbol: "GOOGL", label: "Alphabet", region: "usa" },
      { symbol: "META", label: "Meta", region: "usa" },
      { symbol: "AMZN", label: "Amazon", region: "usa" },
      { symbol: "AVGO", label: "Broadcom", region: "usa" },
      { symbol: "AMD", label: "AMD", region: "usa" },
      { symbol: "PLTR", label: "Palantir", region: "usa" },
      { symbol: "SMCI", label: "Super Micro", region: "usa" },
      { symbol: "NOW", label: "ServiceNow", region: "usa" },
      { symbol: "CRM", label: "Salesforce", region: "usa" },
      { symbol: "SNOW", label: "Snowflake", region: "usa" },
      { symbol: "ORCL", label: "Oracle", region: "usa" },
      { symbol: "ANET", label: "Arista", region: "usa" },
      { symbol: "DELL", label: "Dell", region: "usa" },
      { symbol: "MRVL", label: "Marvell", region: "usa" },
      { symbol: "IBM", label: "IBM", region: "usa" },
      { symbol: "TSLA", label: "Tesla", region: "usa" },
      { symbol: "ARM", label: "Arm", region: "europe" },
      { symbol: "SAP.DE", label: "SAP", region: "europe" },
      { symbol: "ASML.AS", label: "ASML", region: "europe" },
      { symbol: "IFX.DE", label: "Infineon", region: "europe" },
      { symbol: "TSM", label: "TSMC", region: "asia" },
      { symbol: "9988.HK", label: "Alibaba", region: "asia" },
      { symbol: "0700.HK", label: "Tencent", region: "asia" },
      { symbol: "BIDU", label: "Baidu", region: "asia" },
      { symbol: "9984.T", label: "SoftBank", region: "japan" },
      { symbol: "005930.KS", label: "Samsung", region: "asia" },
    ] }],
  },
  {
    key: "software",
    labelKey: "research.markets.sector.software",
    groups: [{ entries: [
      { symbol: "IGV", label: "Software ETF", region: "usa" },
      { symbol: "MSFT", label: "Microsoft", region: "usa" },
      { symbol: "ORCL", label: "Oracle", region: "usa" },
      { symbol: "CRM", label: "Salesforce", region: "usa" },
      { symbol: "ADBE", label: "Adobe", region: "usa" },
      { symbol: "NOW", label: "ServiceNow", region: "usa" },
      { symbol: "INTU", label: "Intuit", region: "usa" },
      { symbol: "IBM", label: "IBM", region: "usa" },
      { symbol: "PLTR", label: "Palantir", region: "usa" },
      { symbol: "PANW", label: "Palo Alto", region: "usa" },
      { symbol: "CRWD", label: "CrowdStrike", region: "usa" },
      { symbol: "DDOG", label: "Datadog", region: "usa" },
      { symbol: "SNOW", label: "Snowflake", region: "usa" },
      { symbol: "WDAY", label: "Workday", region: "usa" },
      { symbol: "ACN", label: "Accenture", region: "usa" },
      { symbol: "SNPS", label: "Synopsys", region: "usa" },
      { symbol: "CDNS", label: "Cadence", region: "usa" },
      { symbol: "FTNT", label: "Fortinet", region: "usa" },
      { symbol: "NET", label: "Cloudflare", region: "usa" },
      { symbol: "SHOP", label: "Shopify" },
      { symbol: "SAP.DE", label: "SAP", region: "europe" },
      { symbol: "DSY.PA", label: "Dassault Systèmes", region: "europe" },
      { symbol: "SAGE.L", label: "Sage", region: "europe" },
      { symbol: "ADYEN.AS", label: "Adyen", region: "europe" },
      { symbol: "INFY", label: "Infosys", region: "asia" },
      { symbol: "035420.KS", label: "Naver", region: "asia" },
      { symbol: "035720.KS", label: "Kakao", region: "asia" },
    ] }],
  },
  {
    key: "space",
    labelKey: "research.markets.sector.space",
    groups: [{ entries: [
      { symbol: "ARKX", label: "Space ETF", region: "usa" },
      { symbol: "SPCX", label: "SpaceX", region: "usa" },
      { symbol: "RKLB", label: "Rocket Lab", region: "usa" },
      { symbol: "ASTS", label: "AST SpaceMobile", region: "usa" },
      { symbol: "LUNR", label: "Intuitive Machines", region: "usa" },
      { symbol: "RDW", label: "Redwire", region: "usa" },
      { symbol: "PL", label: "Planet Labs", region: "usa" },
      { symbol: "BKSY", label: "BlackSky", region: "usa" },
      { symbol: "SPIR", label: "Spire Global", region: "usa" },
      { symbol: "IRDM", label: "Iridium", region: "usa" },
      { symbol: "VSAT", label: "Viasat", region: "usa" },
      { symbol: "GSAT", label: "Globalstar", region: "usa" },
      { symbol: "RTX", label: "RTX", region: "usa" },
      { symbol: "LMT", label: "Lockheed Martin", region: "usa" },
      { symbol: "NOC", label: "Northrop Grumman", region: "usa" },
      { symbol: "BA", label: "Boeing", region: "usa" },
      { symbol: "GD", label: "General Dynamics", region: "usa" },
      { symbol: "LHX", label: "L3Harris", region: "usa" },
      { symbol: "TDG", label: "TransDigm", region: "usa" },
      { symbol: "HEI", label: "Heico", region: "usa" },
      { symbol: "AVAV", label: "AeroVironment", region: "usa" },
      { symbol: "KTOS", label: "Kratos", region: "usa" },
      { symbol: "BWXT", label: "BWX Technologies", region: "usa" },
      { symbol: "AIR.PA", label: "Airbus", region: "europe" },
      { symbol: "BA.L", label: "BAE Systems", region: "europe" },
      { symbol: "HO.PA", label: "Thales", region: "europe" },
      { symbol: "SAF.PA", label: "Safran", region: "europe" },
      { symbol: "LDO.MI", label: "Leonardo", region: "europe" },
      { symbol: "RHM.DE", label: "Rheinmetall", region: "europe" },
      { symbol: "7011.T", label: "Mitsubishi Heavy", region: "japan" },
      { symbol: "7013.T", label: "IHI", region: "japan" },
      { symbol: "012450.KS", label: "Hanwha Aerospace", region: "asia" },
    ] }],
  },
  {
    key: "realEstate",
    labelKey: "research.markets.sector.realEstate",
    groups: [{ entries: [
      { symbol: "VNQ", label: "REIT ETF", region: "usa" },
      { symbol: "PLD", label: "Prologis", region: "usa" },
      { symbol: "AMT", label: "American Tower", region: "usa" },
      { symbol: "EQIX", label: "Equinix", region: "usa" },
      { symbol: "WELL", label: "Welltower", region: "usa" },
      { symbol: "SPG", label: "Simon Property", region: "usa" },
      { symbol: "O", label: "Realty Income", region: "usa" },
      { symbol: "PSA", label: "Public Storage", region: "usa" },
      { symbol: "CCI", label: "Crown Castle", region: "usa" },
      { symbol: "DLR", label: "Digital Realty", region: "usa" },
      { symbol: "VICI", label: "VICI Properties", region: "usa" },
      { symbol: "AVB", label: "AvalonBay", region: "usa" },
      { symbol: "EXR", label: "Extra Space", region: "usa" },
      { symbol: "SBAC", label: "SBA Communications", region: "usa" },
      { symbol: "CBRE", label: "CBRE", region: "usa" },
      { symbol: "EQR", label: "Equity Residential", region: "usa" },
      { symbol: "VTR", label: "Ventas", region: "usa" },
      { symbol: "IRM", label: "Iron Mountain", region: "usa" },
      { symbol: "VNA.DE", label: "Vonovia", region: "europe" },
      { symbol: "SGRO.L", label: "Segro", region: "europe" },
      { symbol: "LAND.L", label: "Land Securities", region: "europe" },
      { symbol: "BLND.L", label: "British Land", region: "europe" },
      { symbol: "0016.HK", label: "Sun Hung Kai", region: "asia" },
      { symbol: "0823.HK", label: "Link REIT", region: "asia" },
      { symbol: "1113.HK", label: "CK Asset", region: "asia" },
      { symbol: "8801.T", label: "Mitsui Fudosan", region: "japan" },
      { symbol: "8802.T", label: "Mitsubishi Estate", region: "japan" },
    ] }],
  },
  {
    key: "energy",
    labelKey: "research.markets.sector.energy",
    groups: [{ entries: [
      { symbol: "XLE", label: "Energy ETF", region: "usa" },
      { symbol: "XOM", label: "Exxon Mobil", region: "usa" },
      { symbol: "CVX", label: "Chevron", region: "usa" },
      { symbol: "COP", label: "ConocoPhillips", region: "usa" },
      { symbol: "SLB", label: "Schlumberger", region: "usa" },
      { symbol: "HAL", label: "Halliburton", region: "usa" },
      { symbol: "EOG", label: "EOG Resources", region: "usa" },
      { symbol: "OXY", label: "Occidental", region: "usa" },
      { symbol: "MPC", label: "Marathon Petroleum", region: "usa" },
      { symbol: "PSX", label: "Phillips 66", region: "usa" },
      { symbol: "VLO", label: "Valero", region: "usa" },
      { symbol: "WMB", label: "Williams", region: "usa" },
      { symbol: "ENB", label: "Enbridge" },
      { symbol: "2222.SR", label: "Saudi Aramco" },
      { symbol: "SHEL.L", label: "Shell", region: "europe" },
      { symbol: "TTE.PA", label: "TotalEnergies", region: "europe" },
      { symbol: "BP.L", label: "BP", region: "europe" },
      { symbol: "EQNR", label: "Equinor", region: "europe" },
      { symbol: "ENI.MI", label: "Eni", region: "europe" },
      { symbol: "REP.MC", label: "Repsol", region: "europe" },
      { symbol: "0857.HK", label: "PetroChina", region: "asia" },
      { symbol: "0883.HK", label: "CNOOC", region: "asia" },
      { symbol: "0386.HK", label: "Sinopec", region: "asia" },
      { symbol: "RELIANCE.NS", label: "Reliance", region: "asia" },
      { symbol: "PBR", label: "Petrobras", region: "latam" },
      { symbol: "EC", label: "Ecopetrol", region: "latam" },
    ] }],
  },
  {
    key: "financials",
    labelKey: "research.markets.sector.financials",
    groups: [{ entries: [
      { symbol: "XLF", label: "Financials ETF", region: "usa" },
      { symbol: "JPM", label: "JPMorgan", region: "usa" },
      { symbol: "BAC", label: "Bank of America", region: "usa" },
      { symbol: "WFC", label: "Wells Fargo", region: "usa" },
      { symbol: "GS", label: "Goldman Sachs", region: "usa" },
      { symbol: "MS", label: "Morgan Stanley", region: "usa" },
      { symbol: "C", label: "Citigroup", region: "usa" },
      { symbol: "V", label: "Visa", region: "usa" },
      { symbol: "MA", label: "Mastercard", region: "usa" },
      { symbol: "AXP", label: "American Express", region: "usa" },
      { symbol: "BRK-B", label: "Berkshire Hathaway", region: "usa" },
      { symbol: "BLK", label: "BlackRock", region: "usa" },
      { symbol: "SCHW", label: "Charles Schwab", region: "usa" },
      { symbol: "OZK", label: "Bank OZK", region: "usa" },
      { symbol: "SPGI", label: "S&P Global", region: "usa" },
      { symbol: "BX", label: "Blackstone", region: "usa" },
      { symbol: "HSBA.L", label: "HSBC", region: "europe" },
      { symbol: "UBS", label: "UBS", region: "europe" },
      { symbol: "BNP.PA", label: "BNP Paribas", region: "europe" },
      { symbol: "ALV.DE", label: "Allianz", region: "europe" },
      { symbol: "ING", label: "ING Groep", region: "europe" },
      { symbol: "DBK.DE", label: "Deutsche Bank", region: "europe" },
      { symbol: "ISP.MI", label: "Intesa Sanpaolo", region: "europe" },
      { symbol: "1398.HK", label: "ICBC", region: "asia" },
      { symbol: "0939.HK", label: "China Construction Bank", region: "asia" },
      { symbol: "1299.HK", label: "AIA", region: "asia" },
      { symbol: "8306.T", label: "Mitsubishi UFJ", region: "japan" },
      { symbol: "HDB", label: "HDFC Bank", region: "asia" },
      { symbol: "IBN", label: "ICICI Bank", region: "asia" },
      { symbol: "ITUB", label: "Itaú Unibanco", region: "latam" },
      { symbol: "NU", label: "Nu Holdings", region: "latam" },
      { symbol: "BAP", label: "Credicorp", region: "latam" },
      { symbol: "BSBR", label: "Santander Brasil", region: "latam" },
    ] }],
  },
  {
    key: "healthcare",
    labelKey: "research.markets.sector.healthcare",
    groups: [{ entries: [
      { symbol: "XLV", label: "Healthcare ETF", region: "usa" },
      { symbol: "LLY", label: "Eli Lilly", region: "usa" },
      { symbol: "UNH", label: "UnitedHealth", region: "usa" },
      { symbol: "JNJ", label: "Johnson & Johnson", region: "usa" },
      { symbol: "MRK", label: "Merck", region: "usa" },
      { symbol: "ABBV", label: "AbbVie", region: "usa" },
      { symbol: "PFE", label: "Pfizer", region: "usa" },
      { symbol: "TMO", label: "Thermo Fisher", region: "usa" },
      { symbol: "ABT", label: "Abbott", region: "usa" },
      { symbol: "DHR", label: "Danaher", region: "usa" },
      { symbol: "AMGN", label: "Amgen", region: "usa" },
      { symbol: "MDT", label: "Medtronic", region: "usa" },
      { symbol: "ISRG", label: "Intuitive Surgical", region: "usa" },
      { symbol: "NVO", label: "Novo Nordisk", region: "europe" },
      { symbol: "AZN.L", label: "AstraZeneca", region: "europe" },
      { symbol: "NOVN.SW", label: "Novartis", region: "europe" },
      { symbol: "RO.SW", label: "Roche", region: "europe" },
      { symbol: "SAN.PA", label: "Sanofi", region: "europe" },
      { symbol: "GSK.L", label: "GSK", region: "europe" },
      { symbol: "BAYN.DE", label: "Bayer", region: "europe" },
      { symbol: "SHL.DE", label: "Siemens Healthineers", region: "europe" },
      { symbol: "4502.T", label: "Takeda", region: "japan" },
      { symbol: "4568.T", label: "Daiichi Sankyo", region: "japan" },
      { symbol: "4519.T", label: "Chugai", region: "japan" },
      { symbol: "2269.HK", label: "WuXi Biologics", region: "asia" },
    ] }],
  },
  {
    key: "automotive",
    labelKey: "research.markets.sector.automotive",
    groups: [{ entries: [
      { symbol: "TSLA", label: "Tesla", region: "usa" },
      { symbol: "F", label: "Ford", region: "usa" },
      { symbol: "GM", label: "General Motors", region: "usa" },
      { symbol: "RIVN", label: "Rivian", region: "usa" },
      { symbol: "LCID", label: "Lucid", region: "usa" },
      { symbol: "MBG.DE", label: "Mercedes-Benz", region: "europe" },
      { symbol: "VOW3.DE", label: "Volkswagen", region: "europe" },
      { symbol: "BMW.DE", label: "BMW", region: "europe" },
      { symbol: "P911.DE", label: "Porsche", region: "europe" },
      { symbol: "RACE", label: "Ferrari", region: "europe" },
      { symbol: "STLA", label: "Stellantis", region: "europe" },
      { symbol: "RNO.PA", label: "Renault", region: "europe" },
      { symbol: "CON.DE", label: "Continental", region: "europe" },
      { symbol: "TM", label: "Toyota", region: "japan" },
      { symbol: "HMC", label: "Honda", region: "japan" },
      { symbol: "7201.T", label: "Nissan", region: "japan" },
      { symbol: "7269.T", label: "Suzuki", region: "japan" },
      { symbol: "005380.KS", label: "Hyundai", region: "asia" },
      { symbol: "000270.KS", label: "Kia", region: "asia" },
      { symbol: "BYDDY", label: "BYD", region: "asia" },
      { symbol: "NIO", label: "NIO", region: "asia" },
      { symbol: "LI", label: "Li Auto", region: "asia" },
      { symbol: "XPEV", label: "XPeng", region: "asia" },
    ] }],
  },
  {
    key: "consumer",
    labelKey: "research.markets.sector.consumer",
    groups: [{ entries: [
      { symbol: "AMZN", label: "Amazon", region: "usa" },
      { symbol: "WMT", label: "Walmart", region: "usa" },
      { symbol: "COST", label: "Costco", region: "usa" },
      { symbol: "HD", label: "Home Depot", region: "usa" },
      { symbol: "KO", label: "Coca-Cola", region: "usa" },
      { symbol: "PG", label: "Procter & Gamble", region: "usa" },
      { symbol: "PEP", label: "PepsiCo", region: "usa" },
      { symbol: "MCD", label: "McDonald's", region: "usa" },
      { symbol: "NKE", label: "Nike", region: "usa" },
      { symbol: "SBUX", label: "Starbucks", region: "usa" },
      { symbol: "PM", label: "Philip Morris", region: "usa" },
      { symbol: "DIS", label: "Disney", region: "usa" },
      { symbol: "BKNG", label: "Booking", region: "usa" },
      { symbol: "LOW", label: "Lowe's", region: "usa" },
      { symbol: "MC.PA", label: "LVMH", region: "europe" },
      { symbol: "NESN.SW", label: "Nestlé", region: "europe" },
      { symbol: "OR.PA", label: "L'Oréal", region: "europe" },
      { symbol: "DEO", label: "Diageo", region: "europe" },
      { symbol: "RMS.PA", label: "Hermès", region: "europe" },
      { symbol: "ULVR.L", label: "Unilever", region: "europe" },
      { symbol: "ABI.BR", label: "AB InBev", region: "europe" },
      { symbol: "ADS.DE", label: "Adidas", region: "europe" },
      { symbol: "CFR.SW", label: "Richemont", region: "europe" },
      { symbol: "9988.HK", label: "Alibaba", region: "asia" },
      { symbol: "PDD", label: "PDD", region: "asia" },
      { symbol: "3690.HK", label: "Meituan", region: "asia" },
      { symbol: "9983.T", label: "Fast Retailing", region: "japan" },
      { symbol: "7974.T", label: "Nintendo", region: "japan" },
      { symbol: "600519.SS", label: "Kweichow Moutai", region: "asia" },
      { symbol: "MELI", label: "MercadoLibre", region: "latam" },
      { symbol: "FMX", label: "FEMSA", region: "latam" },
      { symbol: "ABEV", label: "Ambev", region: "latam" },
      { symbol: "KOF", label: "Coca-Cola FEMSA", region: "latam" },
    ] }],
  },
  {
    key: "quantum",
    labelKey: "research.markets.sector.quantum",
    groups: [{ entries: [
      { symbol: "QTUM", label: "Quantum ETF", region: "usa" },
      { symbol: "IONQ", label: "IonQ", region: "usa" },
      { symbol: "RGTI", label: "Rigetti", region: "usa" },
      { symbol: "QBTS", label: "D-Wave Quantum", region: "usa" },
      { symbol: "QUBT", label: "Quantum Computing Inc", region: "usa" },
      { symbol: "LAES", label: "SEALSQ", region: "usa" },
      { symbol: "IBM", label: "IBM", region: "usa" },
      { symbol: "GOOGL", label: "Alphabet", region: "usa" },
      { symbol: "MSFT", label: "Microsoft", region: "usa" },
      { symbol: "NVDA", label: "Nvidia", region: "usa" },
      { symbol: "HON", label: "Honeywell", region: "usa" },
      { symbol: "AMZN", label: "Amazon", region: "usa" },
      { symbol: "INTC", label: "Intel", region: "usa" },
      { symbol: "ARQQ", label: "Arqit Quantum", region: "europe" },
      { symbol: "6702.T", label: "Fujitsu", region: "japan" },
    ] }],
  },
  {
    key: "defense",
    labelKey: "research.markets.sector.defense",
    groups: [{ entries: [
      { symbol: "ITA", label: "Defense ETF", region: "usa" },
      { symbol: "LMT", label: "Lockheed Martin", region: "usa" },
      { symbol: "RTX", label: "RTX", region: "usa" },
      { symbol: "NOC", label: "Northrop Grumman", region: "usa" },
      { symbol: "GD", label: "General Dynamics", region: "usa" },
      { symbol: "LHX", label: "L3Harris", region: "usa" },
      { symbol: "BA", label: "Boeing", region: "usa" },
      { symbol: "HII", label: "Huntington Ingalls", region: "usa" },
      { symbol: "LDOS", label: "Leidos", region: "usa" },
      { symbol: "AXON", label: "Axon", region: "usa" },
      { symbol: "PLTR", label: "Palantir", region: "usa" },
      { symbol: "KTOS", label: "Kratos", region: "usa" },
      { symbol: "AVAV", label: "AeroVironment", region: "usa" },
      { symbol: "HWM", label: "Howmet", region: "usa" },
      { symbol: "BA.L", label: "BAE Systems", region: "europe" },
      { symbol: "RHM.DE", label: "Rheinmetall", region: "europe" },
      { symbol: "HO.PA", label: "Thales", region: "europe" },
      { symbol: "SAF.PA", label: "Safran", region: "europe" },
      { symbol: "LDO.MI", label: "Leonardo", region: "europe" },
      { symbol: "HAG.DE", label: "Hensoldt", region: "europe" },
      { symbol: "SAAB-B.ST", label: "Saab", region: "europe" },
      { symbol: "AM.PA", label: "Dassault Aviation", region: "europe" },
      { symbol: "7011.T", label: "Mitsubishi Heavy", region: "japan" },
      { symbol: "012450.KS", label: "Hanwha Aerospace", region: "asia" },
      { symbol: "047810.KS", label: "Korea Aerospace", region: "asia" },
    ] }],
  },
  {
    key: "industrials",
    labelKey: "research.markets.sector.industrials",
    groups: [{ entries: [
      { symbol: "XLI", label: "Industrials ETF", region: "usa" },
      { symbol: "GE", label: "GE Aerospace", region: "usa" },
      { symbol: "CAT", label: "Caterpillar", region: "usa" },
      { symbol: "HON", label: "Honeywell", region: "usa" },
      { symbol: "UNP", label: "Union Pacific", region: "usa" },
      { symbol: "UPS", label: "UPS", region: "usa" },
      { symbol: "DE", label: "Deere", region: "usa" },
      { symbol: "ETN", label: "Eaton", region: "usa" },
      { symbol: "MMM", label: "3M", region: "usa" },
      { symbol: "EMR", label: "Emerson", region: "usa" },
      { symbol: "ITW", label: "Illinois Tool Works", region: "usa" },
      { symbol: "PH", label: "Parker Hannifin", region: "usa" },
      { symbol: "CMI", label: "Cummins", region: "usa" },
      { symbol: "FDX", label: "FedEx", region: "usa" },
      { symbol: "SIE.DE", label: "Siemens", region: "europe" },
      { symbol: "SU.PA", label: "Schneider Electric", region: "europe" },
      { symbol: "ABBN.SW", label: "ABB", region: "europe" },
      { symbol: "AIR.PA", label: "Airbus", region: "europe" },
      { symbol: "RR.L", label: "Rolls-Royce", region: "europe" },
      { symbol: "ATCO-A.ST", label: "Atlas Copco", region: "europe" },
      { symbol: "VOLV-B.ST", label: "Volvo", region: "europe" },
      { symbol: "6301.T", label: "Komatsu", region: "japan" },
      { symbol: "6501.T", label: "Hitachi", region: "japan" },
      { symbol: "7011.T", label: "Mitsubishi Heavy", region: "japan" },
      { symbol: "WEGE3.SA", label: "WEG", region: "latam" },
    ] }],
  },
  {
    key: "utilities",
    labelKey: "research.markets.sector.utilities",
    groups: [{ entries: [
      { symbol: "XLU", label: "Utilities ETF", region: "usa" },
      { symbol: "NEE", label: "NextEra Energy", region: "usa" },
      { symbol: "DUK", label: "Duke Energy", region: "usa" },
      { symbol: "SO", label: "Southern Company", region: "usa" },
      { symbol: "D", label: "Dominion", region: "usa" },
      { symbol: "AEP", label: "American Electric Power", region: "usa" },
      { symbol: "CEG", label: "Constellation Energy", region: "usa" },
      { symbol: "VST", label: "Vistra", region: "usa" },
      { symbol: "EXC", label: "Exelon", region: "usa" },
      { symbol: "SRE", label: "Sempra", region: "usa" },
      { symbol: "XEL", label: "Xcel Energy", region: "usa" },
      { symbol: "PEG", label: "Public Service Enterprise", region: "usa" },
      { symbol: "IBE.MC", label: "Iberdrola", region: "europe" },
      { symbol: "ENEL.MI", label: "Enel", region: "europe" },
      { symbol: "EOAN.DE", label: "E.ON", region: "europe" },
      { symbol: "RWE.DE", label: "RWE", region: "europe" },
      { symbol: "NG.L", label: "National Grid", region: "europe" },
      { symbol: "ENGI.PA", label: "Engie", region: "europe" },
      { symbol: "SSE.L", label: "SSE", region: "europe" },
      { symbol: "9501.T", label: "TEPCO", region: "japan" },
      { symbol: "9503.T", label: "Kansai Electric", region: "japan" },
      { symbol: "0002.HK", label: "CLP Holdings", region: "asia" },
      { symbol: "ENIC", label: "Enel Chile", region: "latam" },
      { symbol: "CIG", label: "Cemig", region: "latam" },
    ] }],
  },
  {
    key: "telecom",
    labelKey: "research.markets.sector.telecom",
    groups: [{ entries: [
      { symbol: "T", label: "AT&T", region: "usa" },
      { symbol: "VZ", label: "Verizon", region: "usa" },
      { symbol: "TMUS", label: "T-Mobile US", region: "usa" },
      { symbol: "CMCSA", label: "Comcast", region: "usa" },
      { symbol: "CHTR", label: "Charter", region: "usa" },
      { symbol: "DTE.DE", label: "Deutsche Telekom", region: "europe" },
      { symbol: "VOD.L", label: "Vodafone", region: "europe" },
      { symbol: "ORA.PA", label: "Orange", region: "europe" },
      { symbol: "TEF.MC", label: "Telefónica", region: "europe" },
      { symbol: "TIT.MI", label: "Telecom Italia", region: "europe" },
      { symbol: "BT-A.L", label: "BT Group", region: "europe" },
      { symbol: "9432.T", label: "NTT", region: "japan" },
      { symbol: "9433.T", label: "KDDI", region: "japan" },
      { symbol: "9434.T", label: "SoftBank Corp", region: "japan" },
      { symbol: "0941.HK", label: "China Mobile", region: "asia" },
      { symbol: "0762.HK", label: "China Unicom", region: "asia" },
      { symbol: "BHARTIARTL.NS", label: "Bharti Airtel", region: "asia" },
      { symbol: "SKM", label: "SK Telecom", region: "asia" },
      { symbol: "AMX", label: "América Móvil", region: "latam" },
      { symbol: "VIV", label: "Telefônica Brasil", region: "latam" },
      { symbol: "TIMB", label: "TIM Brasil", region: "latam" },
    ] }],
  },
  {
    key: "payments",
    labelKey: "research.markets.sector.payments",
    groups: [{ entries: [
      { symbol: "V", label: "Visa", region: "usa" },
      { symbol: "MA", label: "Mastercard", region: "usa" },
      { symbol: "AXP", label: "American Express", region: "usa" },
      { symbol: "PYPL", label: "PayPal", region: "usa" },
      { symbol: "XYZ", label: "Block", region: "usa" },
      { symbol: "FISV", label: "Fiserv", region: "usa" },
      { symbol: "GPN", label: "Global Payments", region: "usa" },
      { symbol: "FIS", label: "FIS", region: "usa" },
      { symbol: "COIN", label: "Coinbase", region: "usa" },
      { symbol: "HOOD", label: "Robinhood", region: "usa" },
      { symbol: "AFRM", label: "Affirm", region: "usa" },
      { symbol: "SOFI", label: "SoFi", region: "usa" },
      { symbol: "TOST", label: "Toast", region: "usa" },
      { symbol: "ADYEN.AS", label: "Adyen", region: "europe" },
      { symbol: "NEXI.MI", label: "Nexi", region: "europe" },
      { symbol: "WLN.PA", label: "Worldline", region: "europe" },
      { symbol: "WISE.L", label: "Wise", region: "europe" },
      { symbol: "SE", label: "Sea", region: "asia" },
      { symbol: "PAYTM.NS", label: "Paytm", region: "asia" },
      { symbol: "NU", label: "Nu Holdings", region: "latam" },
      { symbol: "STNE", label: "StoneCo", region: "latam" },
      { symbol: "DLO", label: "DLocal", region: "latam" },
      { symbol: "PAGS", label: "PagSeguro", region: "latam" },
    ] }],
  },
  {
    key: "crypto",
    labelKey: "research.markets.sector.crypto",
    groups: [{ entries: [
      { symbol: "BTC-USD", label: "Bitcoin" },
      { symbol: "ETH-USD", label: "Ethereum" },
      { symbol: "SOL-USD", label: "Solana" },
      { symbol: "XRP-USD", label: "XRP" },
      { symbol: "BNB-USD", label: "BNB" },
      { symbol: "DOGE-USD", label: "Dogecoin" },
      { symbol: "COIN", label: "Coinbase", region: "usa" },
      { symbol: "MSTR", label: "Strategy", region: "usa" },
      { symbol: "HOOD", label: "Robinhood", region: "usa" },
      { symbol: "MARA", label: "MARA Holdings", region: "usa" },
      { symbol: "RIOT", label: "Riot Platforms", region: "usa" },
      { symbol: "CLSK", label: "CleanSpark", region: "usa" },
      { symbol: "HUT", label: "Hut 8", region: "usa" },
      { symbol: "CIFR", label: "Cipher Mining", region: "usa" },
      { symbol: "IREN", label: "IREN", region: "usa" },
      { symbol: "CORZ", label: "Core Scientific", region: "usa" },
      { symbol: "IBIT", label: "iShares BTC ETF", region: "usa" },
      { symbol: "GLXY", label: "Galaxy Digital", region: "usa" },
      { symbol: "8698.T", label: "Monex Group", region: "japan" },
    ] }],
  },
  {
    key: "airlines",
    labelKey: "research.markets.sector.airlines",
    groups: [{ entries: [
      { symbol: "JETS", label: "Airlines ETF", region: "usa" },
      { symbol: "DAL", label: "Delta Air Lines", region: "usa" },
      { symbol: "UAL", label: "United Airlines", region: "usa" },
      { symbol: "AAL", label: "American Airlines", region: "usa" },
      { symbol: "LUV", label: "Southwest", region: "usa" },
      { symbol: "ALK", label: "Alaska Air", region: "usa" },
      { symbol: "BKNG", label: "Booking", region: "usa" },
      { symbol: "ABNB", label: "Airbnb", region: "usa" },
      { symbol: "EXPE", label: "Expedia", region: "usa" },
      { symbol: "MAR", label: "Marriott", region: "usa" },
      { symbol: "HLT", label: "Hilton", region: "usa" },
      { symbol: "RCL", label: "Royal Caribbean", region: "usa" },
      { symbol: "CCL", label: "Carnival", region: "usa" },
      { symbol: "RYAAY", label: "Ryanair", region: "europe" },
      { symbol: "IAG.L", label: "IAG", region: "europe" },
      { symbol: "LHA.DE", label: "Lufthansa", region: "europe" },
      { symbol: "AF.PA", label: "Air France-KLM", region: "europe" },
      { symbol: "EZJ.L", label: "easyJet", region: "europe" },
      { symbol: "9201.T", label: "Japan Airlines", region: "japan" },
      { symbol: "9202.T", label: "ANA Holdings", region: "japan" },
      { symbol: "TCOM", label: "Trip.com", region: "asia" },
      { symbol: "0293.HK", label: "Cathay Pacific", region: "asia" },
      { symbol: "CPA", label: "Copa Holdings", region: "latam" },
      { symbol: "VLRS", label: "Volaris", region: "latam" },
      { symbol: "AZUL", label: "Azul", region: "latam" },
    ] }],
  },
];

const REGION_OPTIONS: ReadonlyArray<{ key: Region; labelKey: string }> = [
  { key: "worldwide", labelKey: "research.markets.region.worldwide" },
  { key: "usa", labelKey: "research.markets.region.usa" },
  { key: "europe", labelKey: "research.markets.region.europe" },
  { key: "asia", labelKey: "research.markets.region.asia" },
  { key: "japan", labelKey: "research.markets.region.japan" },
  { key: "latam", labelKey: "research.markets.region.latam" },
];

// Sector switcher: "Overview" (the region's Indices + Top stocks) plus each
// themed basket.
const SECTOR_OPTIONS: ReadonlyArray<{ key: string; labelKey: string }> = [
  { key: "overview", labelKey: "research.markets.sector.overview" },
  ...SECTOR_VIEWS.map((v) => ({ key: v.key, labelKey: v.labelKey })),
];

interface OverviewQuote {
  symbol: string;
  changePercent: number;
}

// ±3% saturates the tint; the percentage text always stays foreground for
// guaranteed contrast in both themes — the gradient carries the red/green
// signal, the sign carries it for color-blind readers.
const SATURATION_CAP = 3;

function heatStyle(pct: number | undefined): CSSProperties {
  if (pct == null) return {};
  const intensity = Math.min(Math.abs(pct) / SATURATION_CAP, 1);
  const alpha = 0.14 + intensity * 0.52;
  const [r, g, b] = pct >= 0 ? [34, 197, 94] : [239, 68, 68];
  return {
    backgroundImage: `linear-gradient(135deg, rgba(${r},${g},${b},${alpha}) 0%, rgba(${r},${g},${b},${alpha * 0.45}) 100%)`,
  };
}

export default function MarketOverviewPage() {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const isOnline = useOnlineStatus();
  const { data: investmentsData } = useInvestmentsQuery();
  const [region, setRegion] = useState<Region>("worldwide");
  const [sector, setSector] = useState<string>("overview");

  // Symbols the user actually holds, so their tiles get an accent ring + star.
  // Match the investment's symbol and (for Yahoo-priced holdings) its provider
  // id, both upper-cased. Crypto tiles use Yahoo pairs (e.g. BTC-USD) while a
  // holding usually stores the bare base ticker, so we also fold off "-USD".
  const heldSymbols = useMemo(() => {
    const set = new Set<string>();
    for (const inv of investmentsData?.items ?? []) {
      if (inv.symbol) set.add(inv.symbol.toUpperCase());
      if (inv.price_provider === "yahoo" && inv.price_provider_id) {
        set.add(inv.price_provider_id.toUpperCase());
      }
    }
    return set;
  }, [investmentsData]);

  const isHeld = (symbol: string): boolean => {
    const s = symbol.toUpperCase();
    return heldSymbols.has(s) || (s.endsWith("-USD") && heldSymbols.has(s.slice(0, -4)));
  };

  // Region is the global axis. With "Overview" selected we show that region's
  // Indices + Top stocks; with a sector selected we show its basket filtered to
  // the region (Worldwide keeps every member; a region keeps only its tagged
  // members). Filtering is by tag, not a second fetch, so the basket stays one
  // curated config.
  const groups = useMemo<ReadonlyArray<ViewGroup>>(() => {
    if (sector === "overview") {
      const rv = REGION_VIEWS.find((v) => v.key === region) ?? REGION_VIEWS[0];
      return rv.groups;
    }
    const sv = SECTOR_VIEWS.find((v) => v.key === sector) ?? SECTOR_VIEWS[0];
    const all = sv.groups[0]?.entries ?? [];
    const entries = region === "worldwide" ? all : all.filter((e) => e.region === region);
    return [{ entries }];
  }, [region, sector]);

  // One batch quote per active selection. Same cadence/guards as the home
  // benchmark strip: 60s poll, online-gated, price-only (we only read
  // changePercent).
  const symbols = useMemo(
    () => Array.from(new Set(groups.flatMap((grp) => grp.entries.map((e) => e.symbol)))).join(","),
    [groups],
  );

  const { data } = useQuery({
    queryKey: ["market-overview", region, sector],
    queryFn: () => apiClient.getMarketQuotes<OverviewQuote>(symbols, { detail: "basic" }),
    enabled: isOnline && symbols.length > 0,
    staleTime: 60_000,
    refetchInterval: isOnline ? 60_000 : false,
    refetchOnWindowFocus: false,
    retry: isOnline ? 1 : false,
  });

  const pctMap = useMemo(
    () => new Map((data?.quotes ?? []).map((q) => [q.symbol, q.changePercent])),
    [data],
  );

  const goToSymbol = (symbol: string) => {
    navigate(`/research/market?symbol=${encodeURIComponent(symbol)}`);
  };

  const showHeadings = groups.length > 1;

  const renderGrid = (entries: ReadonlyArray<SymbolEntry>) => (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
      {entries.map((entry) => {
        const pct = pctMap.get(entry.symbol);
        const up = (pct ?? 0) >= 0;
        const held = isHeld(entry.symbol);
        return (
          <button
            key={entry.symbol}
            onClick={() => goToSymbol(entry.symbol)}
            style={heatStyle(pct)}
            title={held ? t("research.markets.held") : undefined}
            className={cn(
              "relative flex flex-col gap-1 rounded-xl border border-border/40 p-3.5 text-left transition-colors",
              "micro-lift hover:border-primary/40 outline-none focus-visible:ring-2 focus-visible:ring-ring",
              pct == null && "bg-muted/20",
              held &&
                "border-accent/60 ring-2 ring-accent ring-offset-1 ring-offset-background shadow-[0_0_14px_-2px_hsl(var(--accent)/0.55)]",
            )}
          >
            {held && (
              <Star
                aria-hidden
                className="absolute right-2 top-2 h-3.5 w-3.5 fill-accent text-accent drop-shadow-[0_1px_1px_rgba(0,0,0,0.35)]"
              />
            )}
            <span className={cn("truncate text-xs font-medium text-foreground/70", held && "pr-4")}>
              {entry.label}
            </span>
            {pct != null ? (
              <span className="text-2xl font-bold tabular-nums text-foreground sm:text-3xl">
                {up ? "+" : "−"}{Math.abs(pct).toFixed(2)}%
              </span>
            ) : (
              <span className="text-2xl font-bold tabular-nums text-muted-foreground/40 sm:text-3xl">—</span>
            )}
            <span className="truncate font-mono text-[10px] text-foreground/50">{entry.symbol}</span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="space-y-6 animate-in">
      <PageHeader title={t("research.markets.title")} subtitle={t("research.markets.subtitle")} icon={Globe} />

      <div className="space-y-3">
        <ToggleCluster
          label={t("research.markets.regions")}
          options={REGION_OPTIONS}
          value={region}
          onChange={(v) => setRegion(v as Region)}
          t={t}
        />
        <ToggleCluster
          label={t("research.markets.sectors")}
          options={SECTOR_OPTIONS}
          value={sector}
          onChange={setSector}
          t={t}
        />
      </div>

      {groups.map((group, i) => (
        <section key={group.titleKey ?? i} className="space-y-3">
          {showHeadings && group.titleKey && (
            <h2 className="text-sm font-semibold text-muted-foreground">{t(group.titleKey)}</h2>
          )}
          {group.entries.length > 0 ? (
            renderGrid(group.entries)
          ) : (
            <p className="rounded-xl border border-dashed border-border/40 px-4 py-8 text-center text-sm text-muted-foreground">
              {t("research.markets.empty")}
            </p>
          )}
        </section>
      ))}
    </div>
  );
}

interface ToggleClusterProps {
  label: string;
  options: ReadonlyArray<{ key: string; labelKey: string }>;
  value: string;
  onChange: (key: string) => void;
  t: (key: string) => string;
}

function ToggleCluster({ label, options, value, onChange, t }: ToggleClusterProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="w-16 shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      <ToggleGroup
        type="single"
        value={value}
        onValueChange={(v) => v && onChange(v)}
        variant="outline"
        className="flex-wrap justify-start"
      >
        {options.map((o) => (
          <ToggleGroupItem key={o.key} value={o.key} className="px-3">
            {t(o.labelKey)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}
