import { useMemo, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Globe } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useLanguage } from "@/contexts/LanguageContext";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { apiClient } from "@/lib/api";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/shared/PageHeader";

// A market "view" is a curated, themed basket of Yahoo symbols. Regions group
// into Indices + Top stocks; sectors are a single global basket (often led by a
// sector ETF). Yahoo is keyless/unmetered and there's no universe-scan API, so
// membership is a static config baked in here. A symbol Yahoo can't quote
// (coverage drifts by IP/geo) degrades to a neutral em-dash tile.
interface SymbolEntry {
  symbol: string;
  label: string;
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
          { symbol: "ROG.SW", label: "Roche" },
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
          { symbol: "^N225", label: "Nikkei 225" },
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
          { symbol: "941.HK", label: "China Mobile" },
          { symbol: "TSM", label: "TSMC" },
          { symbol: "005930.KS", label: "Samsung" },
          { symbol: "000660.KS", label: "SK Hynix" },
          { symbol: "TM", label: "Toyota" },
          { symbol: "SONY", label: "Sony" },
          { symbol: "6861.T", label: "Keyence" },
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
];

const SECTOR_VIEWS: ReadonlyArray<MarketView> = [
  {
    key: "semiconductors",
    labelKey: "research.markets.sector.semiconductors",
    groups: [{ entries: [
      { symbol: "SMH", label: "Semis ETF" },
      { symbol: "NVDA", label: "Nvidia" },
      { symbol: "TSM", label: "TSMC" },
      { symbol: "ASML.AS", label: "ASML" },
      { symbol: "AVGO", label: "Broadcom" },
      { symbol: "AMD", label: "AMD" },
      { symbol: "QCOM", label: "Qualcomm" },
      { symbol: "TXN", label: "Texas Instruments" },
      { symbol: "INTC", label: "Intel" },
      { symbol: "MU", label: "Micron" },
      { symbol: "AMAT", label: "Applied Materials" },
      { symbol: "LRCX", label: "Lam Research" },
      { symbol: "KLAC", label: "KLA" },
      { symbol: "ADI", label: "Analog Devices" },
      { symbol: "MRVL", label: "Marvell" },
      { symbol: "MCHP", label: "Microchip" },
      { symbol: "NXPI", label: "NXP" },
      { symbol: "ARM", label: "Arm" },
      { symbol: "STM", label: "STMicro" },
      { symbol: "000660.KS", label: "SK Hynix" },
    ] }],
  },
  {
    key: "ai",
    labelKey: "research.markets.sector.ai",
    groups: [{ entries: [
      { symbol: "NVDA", label: "Nvidia" },
      { symbol: "MSFT", label: "Microsoft" },
      { symbol: "GOOGL", label: "Alphabet" },
      { symbol: "META", label: "Meta" },
      { symbol: "AMZN", label: "Amazon" },
      { symbol: "AVGO", label: "Broadcom" },
      { symbol: "AMD", label: "AMD" },
      { symbol: "TSM", label: "TSMC" },
      { symbol: "PLTR", label: "Palantir" },
      { symbol: "SMCI", label: "Super Micro" },
      { symbol: "ARM", label: "Arm" },
      { symbol: "NOW", label: "ServiceNow" },
      { symbol: "CRM", label: "Salesforce" },
      { symbol: "SNOW", label: "Snowflake" },
      { symbol: "ORCL", label: "Oracle" },
      { symbol: "ANET", label: "Arista" },
      { symbol: "DELL", label: "Dell" },
      { symbol: "MRVL", label: "Marvell" },
      { symbol: "IBM", label: "IBM" },
      { symbol: "TSLA", label: "Tesla" },
    ] }],
  },
  {
    key: "software",
    labelKey: "research.markets.sector.software",
    groups: [{ entries: [
      { symbol: "IGV", label: "Software ETF" },
      { symbol: "MSFT", label: "Microsoft" },
      { symbol: "ORCL", label: "Oracle" },
      { symbol: "CRM", label: "Salesforce" },
      { symbol: "ADBE", label: "Adobe" },
      { symbol: "SAP.DE", label: "SAP" },
      { symbol: "NOW", label: "ServiceNow" },
      { symbol: "INTU", label: "Intuit" },
      { symbol: "IBM", label: "IBM" },
      { symbol: "SHOP", label: "Shopify" },
      { symbol: "PLTR", label: "Palantir" },
      { symbol: "PANW", label: "Palo Alto" },
      { symbol: "CRWD", label: "CrowdStrike" },
      { symbol: "DDOG", label: "Datadog" },
      { symbol: "SNOW", label: "Snowflake" },
      { symbol: "WDAY", label: "Workday" },
      { symbol: "SNPS", label: "Synopsys" },
      { symbol: "CDNS", label: "Cadence" },
      { symbol: "FTNT", label: "Fortinet" },
      { symbol: "NET", label: "Cloudflare" },
    ] }],
  },
  {
    key: "space",
    labelKey: "research.markets.sector.space",
    groups: [{ entries: [
      { symbol: "ARKX", label: "Space ETF" },
      { symbol: "RKLB", label: "Rocket Lab" },
      { symbol: "ASTS", label: "AST SpaceMobile" },
      { symbol: "LUNR", label: "Intuitive Machines" },
      { symbol: "RDW", label: "Redwire" },
      { symbol: "PL", label: "Planet Labs" },
      { symbol: "BKSY", label: "BlackSky" },
      { symbol: "SPIR", label: "Spire Global" },
      { symbol: "IRDM", label: "Iridium" },
      { symbol: "VSAT", label: "Viasat" },
      { symbol: "GSAT", label: "Globalstar" },
      { symbol: "RTX", label: "RTX" },
      { symbol: "LMT", label: "Lockheed Martin" },
      { symbol: "NOC", label: "Northrop Grumman" },
      { symbol: "BA", label: "Boeing" },
      { symbol: "GD", label: "General Dynamics" },
      { symbol: "LHX", label: "L3Harris" },
      { symbol: "TDG", label: "TransDigm" },
      { symbol: "HEI", label: "Heico" },
      { symbol: "AVAV", label: "AeroVironment" },
      { symbol: "KTOS", label: "Kratos" },
      { symbol: "BWXT", label: "BWX Technologies" },
      { symbol: "AIR.PA", label: "Airbus" },
      { symbol: "BA.L", label: "BAE Systems" },
    ] }],
  },
  {
    key: "realEstate",
    labelKey: "research.markets.sector.realEstate",
    groups: [{ entries: [
      { symbol: "VNQ", label: "REIT ETF" },
      { symbol: "PLD", label: "Prologis" },
      { symbol: "AMT", label: "American Tower" },
      { symbol: "EQIX", label: "Equinix" },
      { symbol: "WELL", label: "Welltower" },
      { symbol: "SPG", label: "Simon Property" },
      { symbol: "O", label: "Realty Income" },
      { symbol: "PSA", label: "Public Storage" },
      { symbol: "CCI", label: "Crown Castle" },
      { symbol: "DLR", label: "Digital Realty" },
      { symbol: "VICI", label: "VICI Properties" },
      { symbol: "AVB", label: "AvalonBay" },
      { symbol: "EXR", label: "Extra Space" },
      { symbol: "SBAC", label: "SBA Communications" },
      { symbol: "CBRE", label: "CBRE" },
      { symbol: "EQR", label: "Equity Residential" },
      { symbol: "VTR", label: "Ventas" },
      { symbol: "IRM", label: "Iron Mountain" },
    ] }],
  },
  {
    key: "energy",
    labelKey: "research.markets.sector.energy",
    groups: [{ entries: [
      { symbol: "XLE", label: "Energy ETF" },
      { symbol: "XOM", label: "Exxon Mobil" },
      { symbol: "CVX", label: "Chevron" },
      { symbol: "SHEL.L", label: "Shell" },
      { symbol: "TTE.PA", label: "TotalEnergies" },
      { symbol: "BP.L", label: "BP" },
      { symbol: "COP", label: "ConocoPhillips" },
      { symbol: "SLB", label: "Schlumberger" },
      { symbol: "EOG", label: "EOG Resources" },
      { symbol: "ENB", label: "Enbridge" },
      { symbol: "EQNR", label: "Equinor" },
      { symbol: "2222.SR", label: "Saudi Aramco" },
      { symbol: "OXY", label: "Occidental" },
      { symbol: "MPC", label: "Marathon Petroleum" },
      { symbol: "PSX", label: "Phillips 66" },
      { symbol: "VLO", label: "Valero" },
      { symbol: "WMB", label: "Williams" },
    ] }],
  },
  {
    key: "financials",
    labelKey: "research.markets.sector.financials",
    groups: [{ entries: [
      { symbol: "XLF", label: "Financials ETF" },
      { symbol: "JPM", label: "JPMorgan" },
      { symbol: "BAC", label: "Bank of America" },
      { symbol: "WFC", label: "Wells Fargo" },
      { symbol: "GS", label: "Goldman Sachs" },
      { symbol: "MS", label: "Morgan Stanley" },
      { symbol: "C", label: "Citigroup" },
      { symbol: "V", label: "Visa" },
      { symbol: "MA", label: "Mastercard" },
      { symbol: "AXP", label: "American Express" },
      { symbol: "BRK-B", label: "Berkshire Hathaway" },
      { symbol: "BLK", label: "BlackRock" },
      { symbol: "SCHW", label: "Charles Schwab" },
      { symbol: "SPGI", label: "S&P Global" },
      { symbol: "BX", label: "Blackstone" },
      { symbol: "HSBA.L", label: "HSBC" },
      { symbol: "UBS", label: "UBS" },
      { symbol: "BNP.PA", label: "BNP Paribas" },
    ] }],
  },
  {
    key: "healthcare",
    labelKey: "research.markets.sector.healthcare",
    groups: [{ entries: [
      { symbol: "XLV", label: "Healthcare ETF" },
      { symbol: "LLY", label: "Eli Lilly" },
      { symbol: "UNH", label: "UnitedHealth" },
      { symbol: "JNJ", label: "Johnson & Johnson" },
      { symbol: "NVO", label: "Novo Nordisk" },
      { symbol: "MRK", label: "Merck" },
      { symbol: "ABBV", label: "AbbVie" },
      { symbol: "PFE", label: "Pfizer" },
      { symbol: "TMO", label: "Thermo Fisher" },
      { symbol: "ABT", label: "Abbott" },
      { symbol: "DHR", label: "Danaher" },
      { symbol: "AMGN", label: "Amgen" },
      { symbol: "MDT", label: "Medtronic" },
      { symbol: "ISRG", label: "Intuitive Surgical" },
      { symbol: "AZN.L", label: "AstraZeneca" },
      { symbol: "NOVN.SW", label: "Novartis" },
      { symbol: "ROG.SW", label: "Roche" },
      { symbol: "SAN.PA", label: "Sanofi" },
    ] }],
  },
  {
    key: "automotive",
    labelKey: "research.markets.sector.automotive",
    groups: [{ entries: [
      { symbol: "TSLA", label: "Tesla" },
      { symbol: "TM", label: "Toyota" },
      { symbol: "F", label: "Ford" },
      { symbol: "GM", label: "General Motors" },
      { symbol: "MBG.DE", label: "Mercedes-Benz" },
      { symbol: "VOW3.DE", label: "Volkswagen" },
      { symbol: "BMW.DE", label: "BMW" },
      { symbol: "P911.DE", label: "Porsche" },
      { symbol: "RACE", label: "Ferrari" },
      { symbol: "STLA", label: "Stellantis" },
      { symbol: "HMC", label: "Honda" },
      { symbol: "005380.KS", label: "Hyundai" },
      { symbol: "BYDDY", label: "BYD" },
      { symbol: "NIO", label: "NIO" },
      { symbol: "LI", label: "Li Auto" },
      { symbol: "XPEV", label: "XPeng" },
      { symbol: "RIVN", label: "Rivian" },
    ] }],
  },
  {
    key: "consumer",
    labelKey: "research.markets.sector.consumer",
    groups: [{ entries: [
      { symbol: "AMZN", label: "Amazon" },
      { symbol: "WMT", label: "Walmart" },
      { symbol: "COST", label: "Costco" },
      { symbol: "HD", label: "Home Depot" },
      { symbol: "MC.PA", label: "LVMH" },
      { symbol: "NESN.SW", label: "Nestlé" },
      { symbol: "KO", label: "Coca-Cola" },
      { symbol: "PG", label: "Procter & Gamble" },
      { symbol: "PEP", label: "PepsiCo" },
      { symbol: "MCD", label: "McDonald's" },
      { symbol: "NKE", label: "Nike" },
      { symbol: "SBUX", label: "Starbucks" },
      { symbol: "PM", label: "Philip Morris" },
      { symbol: "DIS", label: "Disney" },
      { symbol: "BKNG", label: "Booking" },
      { symbol: "LOW", label: "Lowe's" },
      { symbol: "OR.PA", label: "L'Oréal" },
      { symbol: "DEO", label: "Diageo" },
    ] }],
  },
];

const ALL_VIEWS = [...REGION_VIEWS, ...SECTOR_VIEWS];

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
  const [viewKey, setViewKey] = useState<string>("worldwide");

  const view = useMemo(
    () => ALL_VIEWS.find((v) => v.key === viewKey) ?? ALL_VIEWS[0],
    [viewKey],
  );

  // One batch quote per active view. Same cadence/guards as the home benchmark
  // strip: 60s poll, online-gated, price-only (we only read changePercent).
  const symbols = useMemo(
    () => Array.from(new Set(view.groups.flatMap((grp) => grp.entries.map((e) => e.symbol)))).join(","),
    [view],
  );

  const { data } = useQuery({
    queryKey: ["market-overview", view.key],
    queryFn: () => apiClient.getMarketQuotes<OverviewQuote>(symbols, { detail: "basic" }),
    enabled: isOnline,
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

  const showHeadings = view.groups.length > 1;

  const renderGrid = (entries: ReadonlyArray<SymbolEntry>) => (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
      {entries.map((entry) => {
        const pct = pctMap.get(entry.symbol);
        const up = (pct ?? 0) >= 0;
        return (
          <button
            key={entry.symbol}
            onClick={() => goToSymbol(entry.symbol)}
            style={heatStyle(pct)}
            className={cn(
              "flex flex-col gap-1 rounded-xl border border-border/40 p-3.5 text-left transition-all",
              "micro-lift hover:border-primary/40 outline-none focus-visible:ring-2 focus-visible:ring-ring",
              pct == null && "bg-muted/20",
            )}
          >
            <span className="truncate text-xs font-medium text-foreground/70">{entry.label}</span>
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
          views={REGION_VIEWS}
          value={viewKey}
          onChange={setViewKey}
          t={t}
        />
        <ToggleCluster
          label={t("research.markets.sectors")}
          views={SECTOR_VIEWS}
          value={viewKey}
          onChange={setViewKey}
          t={t}
        />
      </div>

      {view.groups.map((group, i) => (
        <section key={group.titleKey ?? i} className="space-y-3">
          {showHeadings && group.titleKey && (
            <h2 className="text-sm font-semibold text-muted-foreground">{t(group.titleKey)}</h2>
          )}
          {renderGrid(group.entries)}
        </section>
      ))}
    </div>
  );
}

interface ToggleClusterProps {
  label: string;
  views: ReadonlyArray<MarketView>;
  value: string;
  onChange: (key: string) => void;
  t: (key: string) => string;
}

function ToggleCluster({ label, views, value, onChange, t }: ToggleClusterProps) {
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
        {views.map((v) => (
          <ToggleGroupItem key={v.key} value={v.key} className="px-3">
            {t(v.labelKey)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}
