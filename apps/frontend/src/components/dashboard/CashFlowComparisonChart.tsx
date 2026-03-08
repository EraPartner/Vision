import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Line, LineChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend, ReferenceLine } from "recharts";
import { Activity } from "lucide-react";
import { formatCurrency } from "@/utils/currency";

interface DayData {
  day: number;
  average: number;
  current: number | null;
}

interface CashFlowComparisonProps {
  withoutPlanned: DayData[];
  withPlanned: DayData[];
  currentDay: number;
  month: number;
  year: number;
  embedded?: boolean;
}

function CashFlowLineChart({ data, currentDay }: { data: DayData[]; currentDay: number }) {
  const lastCurrent = data.filter(d => d.current !== null).at(-1);
  const lastAvgAtSameDay = data.find(d => d.day === currentDay);
  const isAboveAverage = lastCurrent && lastAvgAtSameDay ? lastCurrent.current! > lastAvgAtSameDay.average : null;

  return (
    <div>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data} margin={{ top: 10, right: 10, left: 10, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" opacity={0.4} />
          <XAxis
            dataKey="day"
            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
            tickFormatter={(d) => `${d}`}
            interval={4}
          />
          <YAxis
            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
            tickFormatter={(v) => `€${v >= 0 ? '' : ''}${Math.round(v)}`}
            width={65}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "hsl(var(--card))",
              border: "1px solid hsl(var(--border))",
              borderRadius: "12px",
              padding: "12px",
              boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
            }}
            formatter={(value: number | null, name: string) => {
              if (value === null) return ['-', name];
              return [formatCurrency(value, 'EUR'), name === 'average' ? '6-Month Average' : 'Current Month'];
            }}
            labelFormatter={(day) => `Day ${day}`}
          />
          <Legend
            verticalAlign="top"
            height={36}
            formatter={(value) => value === 'average' ? '6-Month Average' : 'Current Month'}
          />
          <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" opacity={0.5} />
          <Line
            type="monotone"
            dataKey="average"
            stroke="hsl(var(--muted-foreground))"
            strokeWidth={2}
            strokeDasharray="8 4"
            dot={false}
            name="average"
          />
          <Line
            type="monotone"
            dataKey="current"
            stroke="hsl(var(--primary))"
            strokeWidth={2.5}
            dot={false}
            name="current"
            connectNulls={false}
          />
        </LineChart>
      </ResponsiveContainer>

      {isAboveAverage !== null && lastCurrent && lastAvgAtSameDay && (
        <div className={`mt-4 flex items-center gap-2 p-3 rounded-lg border ${
          isAboveAverage
            ? 'bg-accent/10 border-accent/30'
            : 'bg-destructive/10 border-destructive/30'
        }`}>
          <div className={`w-2.5 h-2.5 rounded-full ${isAboveAverage ? 'bg-accent' : 'bg-destructive'}`} />
          <p className="text-sm font-medium text-foreground">
            {isAboveAverage ? 'Above' : 'Below'} average by{' '}
            <span className="font-bold">
              {formatCurrency(Math.abs(lastCurrent.current! - lastAvgAtSameDay.average), 'EUR')}
            </span>
            {' '}on day {currentDay}
          </p>
        </div>
      )}
    </div>
  );
}

export function CashFlowComparisonChart({ withoutPlanned, withPlanned, currentDay, month, year, embedded = false }: CashFlowComparisonProps) {
  const monthName = new Date(year, month - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const chartContent = (
    <Tabs defaultValue="without" className="w-full">
      <TabsList className="grid w-full grid-cols-2 mb-4">
        <TabsTrigger value="without">Without Planned</TabsTrigger>
        <TabsTrigger value="with">With Planned</TabsTrigger>
      </TabsList>
      <TabsContent value="without">
        <CashFlowLineChart data={withoutPlanned} currentDay={currentDay} />
      </TabsContent>
      <TabsContent value="with">
        <CashFlowLineChart data={withPlanned} currentDay={currentDay} />
      </TabsContent>
    </Tabs>
  );

  if (embedded) {
    return chartContent;
  }

  return (
    <Card className="relative overflow-hidden border-none shadow-lg hover:shadow-xl transition-all duration-300 hover:-translate-y-1 bg-card backdrop-blur-sm lg:col-span-2">
      <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-primary/10 to-transparent rounded-full -mr-16 -mt-16" />
      <CardHeader className="space-y-3">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center shadow-sm text-primary">
            <Activity className="h-6 w-6" />
          </div>
          <div className="flex-1">
            <CardTitle className="text-xl">Cash Flow Comparison</CardTitle>
            <CardDescription className="text-base">
              {monthName} vs 6-month average — cumulative net cash flow by day
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {chartContent}
      </CardContent>
    </Card>
  );
}
