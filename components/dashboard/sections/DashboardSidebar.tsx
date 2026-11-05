"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DashboardModel } from "@/hooks/useDashboard";
import type { User as AuthUser } from "@/lib/auth/types";
import { isStale, type SyncStatus } from "@/lib/sync/status";
import {
  Presentation,
  BadgeDollarSign,
  BarChart3,
  Bell,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  FileSpreadsheet,
  FileUp,
  Gauge,
  Images,
  KeyRound,
  Layers,
  LayoutList,
  Search,
  Hash,
  LayoutDashboard,
  Lightbulb,
  ListChecks,
  ListOrdered,
  LogOut,
  RefreshCw,
  Settings,
  Sparkles,
  TrendingUp,
  Trophy,
  Tv,
  Upload,
  User as UserIcon,
  Users,
  X, MonitorPlay, GitFork, UsersRound } from "lucide-react";
import { BRAND } from "@/lib/brand";
import { can, type Perm } from "@/lib/auth/permissions";

type Tab = "overview" | "platform" | "programs" | "search" | "trending" | "revenue" | "affiliate" | "growth" | "quality" | "thumbnail" | "youtube" | "acc" | "advice" | "help" | "monthly" | "followers";

interface DashboardSidebarProps extends Pick<DashboardModel, "menuOpen" | "setMenuOpen" | "setSourceOpen"> {
  currentUser?: AuthUser | null;
  activeTab?: Tab;
  onTabChange?: (tab: Tab) => void;
  /** Admins only. undefined = not loaded yet; null = no sync has run. */
  syncStatus?: SyncStatus | null;
  openSyncStatus?: () => void;
  openTvSources?: () => void;
  openProgramSplits?: () => void;
  openSocialAccounts?: () => void;
  openTvUpload?: () => void;
  openNotifications?: () => void;
  onOpenUserManagement?: () => void;
  onOpenChangePassword?: () => void;
  onLogout?: () => void;
}

type NavItem = { id: string; label: string; icon: ReactNode; tab?: Tab; adminOnly?: boolean; perm?: Perm };

const GROUPS: { id: string; label: string; items: NavItem[]; adminOnly?: boolean }[] = [
  {
    id: "reports",
    label: "รายงาน",
    items: [
      { id: "overview", label: "ภาพรวม", icon: <LayoutDashboard /> },
      { id: "search-results", label: "ผลการค้นหา", icon: <Search />, tab: "search" },
      { id: "ranking", label: "Ranking ดี/แย่", icon: <ListOrdered /> },
      { id: "ai-analysis", label: "Executive Analysis", icon: <Lightbulb /> },
      { id: "platforms", label: "แพลตฟอร์ม", icon: <BarChart3 /> },
      { id: "program-report", label: "รวมรายการ", icon: <LayoutList />, tab: "programs" },
      { id: "trending-hashtags", label: "Trending Hashtag", icon: <Hash />, tab: "trending" },
      { id: "topics", label: "ประเภทเนื้อหา", icon: <Sparkles /> },
      { id: "rating", label: "TV Rating", icon: <Tv /> },
      { id: "best", label: "Top 10 ประเด็น", icon: <Trophy /> },
      { id: "compare", label: "ผลงานรายเทป", icon: <FileSpreadsheet /> },
      { id: "monthly-report", label: "รายงานรายเดือน", icon: <Presentation />, tab: "monthly", perm: "monthlyReport" },
      { id: "followers", label: "ผู้ติดตาม", icon: <UsersRound />, tab: "followers" },
    ],
  },
  {
    // Advanced mode: analysis pages, admins only while it is being tried out.
    id: "advanced",
    label: "วิเคราะห์เชิงลึก",
    items: [
      { id: "platform-report", label: "รายงานรวมแพลตฟอร์ม", icon: <Layers />, tab: "platform" },
      { id: "growth", label: "การเติบโต", icon: <TrendingUp />, tab: "growth", perm: "advanced" },
      { id: "quality", label: "คุณภาพคลิป", icon: <Gauge />, tab: "quality", perm: "advanced" },
      { id: "thumbnail", label: "Thumbnail", icon: <Images />, tab: "thumbnail", perm: "advanced" },
      { id: "youtube", label: "YouTube Deep Dive", icon: <MonitorPlay />, tab: "youtube", perm: "deepDive" },
      { id: "advice", label: "คำแนะนำ", icon: <ListChecks />, tab: "advice", perm: "advanced" },
    ],
  },
  {
    id: "revenue",
    label: "รายได้",
    items: [
      { id: "revenue", label: "YouTube Revenue", icon: <BadgeDollarSign />, tab: "revenue", perm: "revenue" },
      { id: "affiliate", label: "Affiliate Program", icon: <BadgeDollarSign />, tab: "affiliate", perm: "revenue" },
      { id: "acc", label: "Monthly ACC", icon: <FileSpreadsheet />, tab: "acc", perm: "revenue" },
    ],
  },
  {
    id: "help",
    label: "ช่วยเหลือ",
    items: [{ id: "help", label: "คู่มือ & FAQ", icon: <CircleHelp />, tab: "help" }],
  },
];
const SECTION_IDS = GROUPS[0].items.filter((i) => !i.tab).map((i) => i.id).filter((id) => id !== "overview");
const GROUP_KEY = "sidebar-groups";

const thTime = (iso: string) =>
  new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

function syncBadge(status: SyncStatus | null | undefined): { tone: string; text: string } {
  if (status === undefined) return { tone: "none", text: "กำลังโหลดสถานะ…" };
  if (!status) return { tone: "warn", text: "ยังไม่มีการ sync" };
  if (status.status === "failed") return { tone: "bad", text: "Sync ล้มเหลว" };
  if (status.status === "blocked") return { tone: "warn", text: "Sync ไม่ผ่านการตรวจ" };
  if (isStale(status)) return { tone: "warn", text: "ไม่มีการ sync เกิน 26 ชม." };
  return { tone: "ok", text: `Sync ล่าสุด ${thTime(status.finishedAt)} น.` };
}

/** Close a popover on outside click or Esc. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

export function DashboardSidebar({
  menuOpen,
  setMenuOpen,
  setSourceOpen,
  currentUser,
  activeTab = "overview",
  onTabChange,
  syncStatus,
  openSyncStatus,
  openTvSources,
  openProgramSplits,
  openSocialAccounts,
  openTvUpload,
  openNotifications,
  onOpenUserManagement,
  onOpenChangePassword,
  onLogout,
}: DashboardSidebarProps) {
  const isAdmin = currentUser?.role === "admin";
  const allowed = (item: NavItem) => (!item.adminOnly || isAdmin) && (!item.perm || can(currentUser, item.perm));
  const [section, setSection] = useState("overview");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [toolsOpen, setToolsOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const toolsRef = useDismiss(toolsOpen, () => setToolsOpen(false));
  const accountRef = useDismiss(accountOpen, () => setAccountOpen(false));

  // Remember which groups are folded (per viewer, optional).
  useEffect(() => {
    try {
      setCollapsed(JSON.parse(localStorage.getItem(GROUP_KEY) || "{}"));
    } catch {
      /* storage unavailable: all groups open */
    }
  }, []);
  const toggleGroup = (id: string) =>
    setCollapsed((c) => {
      const next = { ...c, [id]: !c[id] };
      try {
        localStorage.setItem(GROUP_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });

  // Highlight the section currently on screen.
  useEffect(() => {
    if (activeTab !== "overview") return;
    const onScroll = () => {
      // Page order differs from menu order, so take the section whose top is
      // closest above a line near the top of the screen. At the very bottom
      // the last sections can't reach that line, so take the lowest one.
      const atBottom =
        window.scrollY > 0 && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      const line = atBottom ? Infinity : 90;
      let current = "overview";
      let best = -Infinity;
      for (const id of SECTION_IDS) {
        const rect = document.getElementById(id)?.getBoundingClientRect();
        // Sections hidden on phones have no size (and report top 0): skip them.
        if (!rect || rect.height === 0) continue;
        const top = rect.top;
        if (top <= line && top > best) {
          best = top;
          current = id;
        }
      }
      setSection(current);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [activeTab]);

  // Mobile drawer: Esc closes it and the page behind it stops scrolling.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, setMenuOpen]);

  const go = (item: NavItem) => {
    setMenuOpen(false);
    const tab = item.tab || "overview";
    if (onTabChange && activeTab !== tab) onTabChange(tab);
    // A page of its own opens at its top, not where the last page was scrolled to.
    if (item.tab) window.scrollTo({ top: 0, behavior: "instant" });
    if (!item.tab) setSection(item.id);
  };
  const isActive = (item: NavItem) => (item.tab ? activeTab === item.tab : activeTab === "overview" && section === item.id);
  const run = (fn?: () => void) => () => {
    setToolsOpen(false);
    setAccountOpen(false);
    setMenuOpen(false);
    fn?.();
  };
  const badge = syncBadge(syncStatus);

  return (
    <>
      <div className={`sidebar-backdrop ${menuOpen ? "open" : ""}`} onClick={() => setMenuOpen(false)} aria-hidden="true" />
      <aside className={`sidebar ${menuOpen ? "open" : ""}`}>
        <button type="button" className="sidebar-close" onClick={() => setMenuOpen(false)} aria-label="ปิดเมนู">
          <X />
        </button>
        <div className="brand">
          <h1>{BRAND.product.toUpperCase()}</h1>
        </div>

        <div className="sidebar-scroll">
          {GROUPS.filter((g) => (!g.adminOnly || isAdmin) && g.items.some(allowed)).map((g) => (
            <div key={g.id} className="sidebar-group">
              <button type="button" className="sidebar-group-head" onClick={() => toggleGroup(g.id)} aria-expanded={!collapsed[g.id]}>
                {g.label}
                <ChevronDown className={collapsed[g.id] ? "folded" : ""} />
              </button>
              {!collapsed[g.id] && (
                <nav>
                  {g.items.filter(allowed).map((item) => (
                    <a
                      key={item.id}
                      href={item.tab ? undefined : `#${item.id}`}
                      className={isActive(item) ? "active" : ""}
                      onClick={() => go(item)}
                      role={item.tab ? "button" : undefined}
                    >
                      {item.icon}
                      {item.label}
                    </a>
                  ))}
                </nav>
              )}
            </div>
          ))}
        </div>

        <div className="sidebar-foot">
          {isAdmin ? (
            <button type="button" className={`sidebar-sync ${badge.tone}`} onClick={run(openSyncStatus)} title="เปิดสถานะการ Sync">
              <i />
              <span>{badge.text}</span>
            </button>
          ) : (
            // Everyone else: the latest sync at a glance, without the details.
            <div className={`sidebar-sync sidebar-sync-static ${badge.tone}`} title="สถานะการอัปเดตข้อมูลล่าสุด">
              <i />
              <span>{badge.text}</span>
            </div>
          )}

          {isAdmin && (
            <div className="sidebar-pop-wrap" ref={toolsRef}>
              <button type="button" className="sidebar-foot-btn" onClick={() => setToolsOpen((v) => !v)} aria-expanded={toolsOpen}>
                <Settings />
                <span>เครื่องมือ admin</span>
                <ChevronUp className={toolsOpen ? "" : "folded"} />
              </button>
              {toolsOpen && (
                <div className="sidebar-pop" role="menu">
                  <button type="button" onClick={run(openSyncStatus)}>
                    <RefreshCw /> สถานะการ Sync
                  </button>
                  {openTvUpload && (
                    <button type="button" className="mobile-hide" onClick={run(openTvUpload)}>
                      <FileUp /> อัปโหลดไฟล์ TV
                    </button>
                  )}
                  {openTvSources && (
                    <button type="button" onClick={run(openTvSources)}>
                      <Tv /> แหล่งข้อมูล TV
                    </button>
                  )}
                  {openProgramSplits && (
                    <button type="button" onClick={run(openProgramSplits)}>
                      <GitFork /> แยกรายการย่อย
                    </button>
                  )}
                  {openSocialAccounts && (
                    <button type="button" onClick={run(openSocialAccounts)}>
                      <UsersRound /> บัญชีโซเชียล
                    </button>
                  )}
                  {openNotifications && (
                    <button type="button" onClick={run(openNotifications)}>
                      <Bell /> การแจ้งเตือน
                    </button>
                  )}
                  <button type="button" className="mobile-hide" onClick={run(() => setSourceOpen(true))}>
                    <Upload /> Import Excel / CSV
                  </button>
                  <button type="button" onClick={run(onOpenUserManagement)}>
                    <Users /> จัดการผู้ใช้
                  </button>
                </div>
              )}
            </div>
          )}

          {currentUser && (
            <div className="sidebar-pop-wrap" ref={accountRef}>
              <button type="button" className="sidebar-account" onClick={() => setAccountOpen((v) => !v)} aria-expanded={accountOpen}>
                <span className="sidebar-user-avatar">
                  {currentUser.name ? currentUser.name.charAt(0).toUpperCase() : <UserIcon size={16} />}
                </span>
                <span className="sidebar-account-meta">
                  <b title={currentUser.name}>{currentUser.name}</b>
                  <small className={currentUser.role}>{currentUser.role}</small>
                </span>
                <ChevronUp className={accountOpen ? "" : "folded"} />
              </button>
              {accountOpen && (
                <div className="sidebar-pop" role="menu">
                  <p className="sidebar-pop-email">{currentUser.email}</p>
                  <button type="button" onClick={run(onOpenChangePassword)}>
                    <KeyRound /> เปลี่ยนรหัสผ่าน
                  </button>
                  <button type="button" className="danger" onClick={run(onLogout)}>
                    <LogOut /> ออกจากระบบ
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
