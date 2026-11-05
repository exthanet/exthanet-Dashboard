"use client";

import { BadgeDollarSign, LayoutDashboard } from "lucide-react";

interface SectionTabsProps {
  activeTab: "overview" | "platform" | "programs" | "search" | "trending" | "revenue" | "affiliate" | "growth" | "quality" | "thumbnail" | "youtube" | "acc" | "advice" | "help" | "monthly" | "followers";
  onTabChange: (tab: "overview" | "revenue" | "affiliate") => void;
  /** Revenue and Affiliate tabs (permission "revenue"). */
  canRevenue?: boolean;
}

export function SectionTabs({
  activeTab,
  onTabChange,
  canRevenue = true,
}: SectionTabsProps) {
  return (
    <nav className="top-tab-bar" aria-label="Dashboard sections">
      <div className="top-tabs-group scrollbar-hide">
        <button
          type="button"
          className={`tab-btn ${activeTab === "overview" ? "active" : ""}`}
          onClick={() => onTabChange("overview")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            padding: "9px 15px",
            borderRadius: 9,
            fontWeight: 800,
            fontSize: 12,
            border: "none",
            cursor: "pointer",
            background: activeTab === "overview" ? "#fff" : "transparent",
            color: activeTab === "overview" ? "#0757e8" : "#53627a",
            boxShadow: activeTab === "overview" ? "0 3px 8px #16305b18" : "none",
            transition: "0.2s",
          }}
        >
          <LayoutDashboard size={16} />
          <span>Performance<span className="tab-label-long"> Dashboard</span></span>
        </button>

        {canRevenue && (
          <>
        <button
          type="button"
          className={`tab-btn ${activeTab === "revenue" ? "active" : ""}`}
          onClick={() => onTabChange("revenue")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            padding: "9px 15px",
            borderRadius: 9,
            fontWeight: 800,
            fontSize: 12,
            border: "none",
            cursor: "pointer",
            background: activeTab === "revenue" ? "#fff" : "transparent",
            color: activeTab === "revenue" ? "#2563eb" : "#53627a",
            boxShadow: activeTab === "revenue" ? "0 3px 8px #16305b18" : "none",
            transition: "0.2s",
          }}
        >
          <BadgeDollarSign size={16} />
          <span>YouTube Revenue<span className="tab-label-long"> Report</span></span>
        </button>

        <button
          type="button"
          className={`tab-btn ${activeTab === "affiliate" ? "active" : ""}`}
          onClick={() => onTabChange("affiliate")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            padding: "9px 15px",
            borderRadius: 9,
            fontWeight: 800,
            fontSize: 12,
            border: "none",
            cursor: "pointer",
            background: activeTab === "affiliate" ? "#fff" : "transparent",
            color: activeTab === "affiliate" ? "#0f766e" : "#53627a",
            boxShadow: activeTab === "affiliate" ? "0 3px 8px #16305b18" : "none",
            transition: "0.2s",
          }}
        >
          <BadgeDollarSign size={16} />
          <span>Affiliate<span className="tab-label-long"> Program Report</span></span>
        </button>
          </>
        )}
      </div>

    </nav>
  );
}
