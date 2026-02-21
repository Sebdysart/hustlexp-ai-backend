'use client';

import { useEffect, useState } from 'react';
import { 
  Users, 
  ClipboardList, 
  DollarSign, 
  ShieldAlert,
  TrendingUp,
  TrendingDown
} from 'lucide-react';

interface MetricCardProps {
  title: string;
  value: string;
  change: string;
  changeType: 'positive' | 'negative' | 'neutral';
  icon: React.ElementType;
}

function MetricCard({ title, value, change, changeType, icon: Icon }: MetricCardProps) {
  return (
    <div className="p-6 bg-white rounded-lg shadow-sm border border-gray-200">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-600">{title}</p>
          <p className="mt-2 text-3xl font-semibold text-gray-900">{value}</p>
        </div>
        <div className="p-3 bg-indigo-50 rounded-lg">
          <Icon className="w-6 h-6 text-indigo-600" />
        </div>
      </div>
      <div className="mt-4 flex items-center text-sm">
        {changeType === 'positive' ? (
          <TrendingUp className="w-4 h-4 mr-1 text-green-600" />
        ) : changeType === 'negative' ? (
          <TrendingDown className="w-4 h-4 mr-1 text-red-600" />
        ) : null}
        <span
          className={
            changeType === 'positive'
              ? 'text-green-600'
              : changeType === 'negative'
              ? 'text-red-600'
              : 'text-gray-600'
          }
        >
          {change}
        </span>
        <span className="ml-2 text-gray-500">vs last week</span>
      </div>
    </div>
  );
}

export default function DashboardOverview() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <div className="p-8">Loading...</div>;
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Dashboard Overview</h1>
      <p className="mt-1 text-gray-500">Platform metrics and activity summary</p>

      {/* Metrics Grid */}
      <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title="Total Users"
          value="12,345"
          change="+12%"
          changeType="positive"
          icon={Users}
        />
        <MetricCard
          title="Active Tasks"
          value="1,234"
          change="+5%"
          changeType="positive"
          icon={ClipboardList}
        />
        <MetricCard
          title="GMV (7d)"
          value="$45.2K"
          change="+18%"
          changeType="positive"
          icon={DollarSign}
        />
        <MetricCard
          title="Open Disputes"
          value="23"
          change="-8%"
          changeType="positive"
          icon={ShieldAlert}
        />
      </div>

      {/* Recent Activity */}
      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Recent Tasks */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-lg font-medium text-gray-900">Recent Tasks</h2>
          </div>
          <div className="divide-y divide-gray-200">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="px-6 py-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-900">Task #{1000 + i}</p>
                    <p className="text-sm text-gray-500">Furniture assembly • Seattle, WA</p>
                  </div>
                  <span className="px-2 py-1 text-xs font-medium text-yellow-800 bg-yellow-100 rounded-full">
                    Pending
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Recent Disputes */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-lg font-medium text-gray-900">Recent Disputes</h2>
          </div>
          <div className="divide-y divide-gray-200">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="px-6 py-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-900">Dispute #{500 + i}</p>
                    <p className="text-sm text-gray-500">Quality of work complaint</p>
                  </div>
                  <span className="px-2 py-1 text-xs font-medium text-red-800 bg-red-100 rounded-full">
                    Urgent
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* AI Cost Summary */}
      <div className="mt-8 bg-white rounded-lg shadow-sm border border-gray-200">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-medium text-gray-900">AI Cost Summary (Today)</h2>
        </div>
        <div className="px-6 py-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="p-4 bg-gray-50 rounded-lg">
              <p className="text-sm text-gray-600">Total AI Spend</p>
              <p className="mt-1 text-2xl font-semibold text-gray-900">$127.45</p>
            </div>
            <div className="p-4 bg-gray-50 rounded-lg">
              <p className="text-sm text-gray-600">Total Requests</p>
              <p className="mt-1 text-2xl font-semibold text-gray-900">3,421</p>
            </div>
            <div className="p-4 bg-gray-50 rounded-lg">
              <p className="text-sm text-gray-600">Avg Cost/Request</p>
              <p className="mt-1 text-2xl font-semibold text-gray-900">$0.037</p>
            </div>
          </div>
          
          {/* Agent Breakdown */}
          <div className="mt-6">
            <h3 className="text-sm font-medium text-gray-900 mb-3">By Agent</h3>
            <div className="space-y-2">
              {[
                { name: 'Matchmaker', cost: '$45.20', requests: '1,234' },
                { name: 'Content Moderation', cost: '$38.50', requests: '1,567' },
                { name: 'Judge', cost: '$28.75', requests: '420' },
                { name: 'Dispute', cost: '$15.00', requests: '200' },
              ].map((agent) => (
                <div key={agent.name} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                  <span className="text-sm text-gray-600">{agent.name}</span>
                  <div className="text-right">
                    <span className="text-sm font-medium text-gray-900">{agent.cost}</span>
                    <span className="ml-3 text-xs text-gray-500">({agent.requests} req)</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
