"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/shared/page-header";
import { formatCurrency } from "@/lib/utils";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import {
  BarChart3,
  PieChart as PieChartIcon,
  TrendingUp,
  Loader2,
} from "lucide-react";
import type { InventoryItemWithTotals } from "@/app/api/inventory/route";

const COLORS = ["#16a34a", "#ca8a04", "#dc2626", "#2563eb", "#7c3aed", "#0891b2", "#d946ef"];

interface ReportsData {
  valueByCategory: { name: string; value: number }[];
  itemsByCategory: { name: string; count: number }[];
  topItems: { name: string; value: number }[];
  stockLevels: { name: string; current: number; minimum: number }[];
  totalValue: number;
  totalItems: number;
}

export default function ReportsPage() {
  const [data, setData] = useState<ReportsData | null>(null);
  const [loading, setLoading] = useState(true);

  // Data-only loader (no setState) so the effect below never reaches setState
  // synchronously (react-hooks/set-state-in-effect).
  const loadReports = useCallback(async (): Promise<ReportsData> => {
    // Fetch inventory items to compute reports client-side
    const res = await fetch("/api/inventory");
    if (!res.ok) throw new Error("Failed to fetch reports");
    const json: { data?: InventoryItemWithTotals[] } | InventoryItemWithTotals[] | null =
      await res.json();
    const items: InventoryItemWithTotals[] = Array.isArray(json)
      ? json
      : json?.data || [];

    // Value by category
    const catMap = new Map<string, number>();
    items.forEach((item) => {
      const cat = item.category?.name || "Other";
      catMap.set(cat, (catMap.get(cat) || 0) + (item.totalValue || 0));
    });
    const valueByCategory = Array.from(catMap.entries()).map(([name, value]) => ({
      name,
      value,
    }));

    // Items by category
    const catCount = new Map<string, number>();
    items.forEach((item) => {
      const cat = item.category?.name || "Other";
      catCount.set(cat, (catCount.get(cat) || 0) + 1);
    });
    const itemsByCategory = Array.from(catCount.entries()).map(([name, count]) => ({
      name,
      count,
    }));

    // Top items by value
    const topItems = items
      .sort((a, b) => (b.totalValue || 0) - (a.totalValue || 0))
      .slice(0, 8)
      .map((item) => ({
        name: item.name.length > 15 ? item.name.substring(0, 15) + "..." : item.name,
        value: item.totalValue || 0,
      }));

    // Stock levels
    const stockLevels = items
      .filter((item) => item.minimumStockLevel > 0)
      .slice(0, 8)
      .map((item) => ({
        name: item.name.length > 15 ? item.name.substring(0, 15) + "..." : item.name,
        current: item.totalQuantity || 0,
        minimum: item.minimumStockLevel || 0,
      }));

    return {
      valueByCategory,
      itemsByCategory,
      topItems,
      stockLevels,
      totalValue: items.reduce((sum, item) => sum + (item.totalValue || 0), 0),
      totalItems: items.length,
    };
  }, []);

  useEffect(() => {
    loadReports()
      .then(setData)
      .catch((err: unknown) => console.error("Failed to fetch reports:", err))
      .finally(() => setLoading(false));
  }, [loadReports]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Failed to load reports</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports & Analytics"
        description="Inventory valuation and resource insights"
      />

      {/* Summary Cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-green-50 p-2">
                <BarChart3 className="h-5 w-5 text-green-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{formatCurrency(data.totalValue)}</p>
                <p className="text-xs text-muted-foreground">Total Inventory Value</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-blue-50 p-2">
                <PieChartIcon className="h-5 w-5 text-blue-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{data.totalItems}</p>
                <p className="text-xs text-muted-foreground">Total Inventory Items</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-purple-50 p-2">
                <TrendingUp className="h-5 w-5 text-purple-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{data.valueByCategory.length}</p>
                <p className="text-xs text-muted-foreground">Categories</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Charts Row 1 */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Inventory Value by Category - Pie Chart */}
        <Card>
          <CardHeader>
            <CardTitle>Value by Category</CardTitle>
            <CardDescription>Inventory value distribution</CardDescription>
          </CardHeader>
          <CardContent>
            {data.valueByCategory.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">No data</p>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={data.valueByCategory}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    label={({ name, percent }) =>
                      `${name} (${(percent * 100).toFixed(0)}%)`
                    }
                    outerRadius={100}
                    dataKey="value"
                  >
                    {data.valueByCategory.map((_, index) => (
                      <Cell
                        key={`cell-${index}`}
                        fill={COLORS[index % COLORS.length]}
                      />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value: number) => formatCurrency(value)}
                  />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Items by Category - Bar Chart */}
        <Card>
          <CardHeader>
            <CardTitle>Items by Category</CardTitle>
            <CardDescription>Number of items per category</CardDescription>
          </CardHeader>
          <CardContent>
            {data.itemsByCategory.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">No data</p>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={data.itemsByCategory}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" fontSize={12} />
                  <YAxis />
                  <Tooltip />
                  <Bar dataKey="count" fill="#16a34a" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Charts Row 2 */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Top Items by Value */}
        <Card>
          <CardHeader>
            <CardTitle>Top Items by Value</CardTitle>
            <CardDescription>Highest value inventory items</CardDescription>
          </CardHeader>
          <CardContent>
            {data.topItems.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">No data</p>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={data.topItems} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis type="number" fontSize={12} />
                  <YAxis type="category" dataKey="name" width={120} fontSize={12} />
                  <Tooltip formatter={(value: number) => formatCurrency(value)} />
                  <Bar dataKey="value" fill="#2563eb" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Stock Levels Comparison */}
        <Card>
          <CardHeader>
            <CardTitle>Stock Levels vs Minimum</CardTitle>
            <CardDescription>Current stock compared to minimum levels</CardDescription>
          </CardHeader>
          <CardContent>
            {data.stockLevels.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">No data</p>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={data.stockLevels}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" fontSize={12} />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="current" fill="#16a34a" name="Current" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="minimum" fill="#dc2626" name="Minimum" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Inventory Value Breakdown Table */}
      <Card>
        <CardHeader>
          <CardTitle>Inventory Valuation Summary</CardTitle>
          <CardDescription>Current value breakdown by category</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {data.valueByCategory.map((cat, index) => {
              const pct = ((cat.value / data.totalValue) * 100).toFixed(1);
              return (
                <div key={cat.name} className="flex items-center gap-4">
                  <div
                    className="h-4 w-4 rounded"
                    style={{ backgroundColor: COLORS[index % COLORS.length] }}
                  />
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-sm">{cat.name}</span>
                      <span className="text-sm">{formatCurrency(cat.value)}</span>
                    </div>
                    <div className="mt-1 h-1.5 rounded-full bg-gray-100">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${pct}%`,
                          backgroundColor: COLORS[index % COLORS.length],
                        }}
                      />
                    </div>
                  </div>
                  <span className="text-xs text-muted-foreground w-12 text-right">{pct}%</span>
                </div>
              );
            })}
            <div className="flex items-center justify-between pt-2 border-t">
              <span className="font-bold">Total</span>
              <span className="font-bold">{formatCurrency(data.totalValue)}</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
