"use client";
// ผู้ติดตาม: every company account and its followers, grouped by platform or by show
// (รายการ), with the total and the online views of the last 12 months from masterData.
// Numbers come from accountStats (the daily sync); an account without an API shows the
// admin's typed number marked "รอตรวจสอบ". Click a card for its daily followers;
// download the board as PNG.
import { useEffect, useMemo, useState } from "react";
import { Download, Settings } from "lucide-react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { RecordRow } from "@/lib/dashboard/types";
import {
  PLATFORM_LABEL,
  SOCIAL_PLATFORMS,
  boardTotal,
  currentFollowers,
  followersOn,
  groupOf,
  shortCount,
  type AccountStat,
  type SocialAccount,
  type SocialPlatform,
} from "@/lib/dashboard/socialAccounts";
import { loadAccountStats, loadSocialAccounts } from "@/lib/socialAccountsData";
import { dateLabel } from "@/lib/dashboard/format";
import { track } from "@/lib/loadingBar";

export const PLATFORM_COLOR: Record<SocialPlatform, string> = {
  facebook: "#1877f2",
  instagram: "#d62976",
  tiktok: "#111111",
  youtube: "#ff0000",
  x: "#111111",
  line: "#06c755",
  other: "#5f6b7a",
};
const PENDING = "รอตรวจสอบ";
const VIEW_KEY = "followers-view";
type View = "platform" | "group";

const full = (v: number) => v.toLocaleString("en-US");
const dayTh = (d: string) => (d ? dateLabel(d) : "");
const initials = (name: string) => name.replace(/[^A-Za-z0-9ก-๙]/g, "").slice(0, 4).toUpperCase();

interface Group {
  key: string;
  label: string;
  total: number;
  accounts: SocialAccount[];
}

/** Groups by platform or by show, the larger first; inside a group the larger account first. */
export function groupAccounts(accounts: SocialAccount[], stats: Record<string, AccountStat>, view: View): Group[] {
  const value = (a: SocialAccount) => currentFollowers(a, stats[a.id])?.value || 0;
  const map = new Map<string, Group>();
  for (const a of accounts) {
    const key = view === "platform" ? a.platform : groupOf(a);
    const label = view === "platform" ? PLATFORM_LABEL[a.platform] : groupOf(a);
    const g = map.get(key) || { key, label, total: 0, accounts: [] };
    g.total += value(a);
    g.accounts.push(a);
    map.set(key, g);
  }
  const groups = [...map.values()];
  for (const g of groups) g.accounts.sort((x, y) => value(y) - value(x));
  // Platforms keep their usual order when equal; shows go by size.
  return groups.sort((x, y) => y.total - x.total || SOCIAL_PLATFORMS.indexOf(x.key as SocialPlatform) - SOCIAL_PLATFORMS.indexOf(y.key as SocialPlatform));
}

export function FollowersSection({ rows, isAdmin, openSettings }: { rows: RecordRow[]; isAdmin: boolean; openSettings?: () => void }) {
  const [accounts, setAccounts] = useState<SocialAccount[] | null>(null);
  const [stats, setStats] = useState<Record<string, AccountStat>>({});
  const [error, setError] = useState("");
  const [picked, setPicked] = useState("");
  const [view, setView] = useState<View>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === "group" ? "group" : "platform";
    } catch {
      return "platform";
    }
  });
  const pickView = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* private window: the choice just isn't kept */
    }
  };

  useEffect(() => {
    track(Promise.all([loadSocialAccounts(), loadAccountStats()]))
      .then(([a, s]) => {
        setAccounts(a);
        setStats(s);
      })
      .catch((e) => setError(String(e?.message || e)));
  }, []);

  const shown = useMemo(() => (accounts || []).filter((a) => a.enabled), [accounts]);
  const groups = useMemo(() => groupAccounts(shown, stats, view), [shown, stats, view]);
  const total = useMemo(() => boardTotal(shown, stats), [shown, stats]);
  const pending = useMemo(() => shown.filter((a) => a.source === "manual"), [shown]);
  const pendingTotal = useMemo(() => boardTotal(pending, stats), [pending, stats]);
  const updated = useMemo(
    () =>
      shown
        .filter((a) => a.source !== "manual")
        .map((a) => stats[a.id]?.latest?.date || "")
        .filter(Boolean)
        .sort()
        .pop() || "",
    [shown, stats],
  );
  // Online views of the posts published in the last 12 months (as the deck's "views / year").
  const views12 = useMemo(() => {
    const days = rows.filter((r) => r.platform !== "TV").map((r) => r.date).sort();
    const last = days[days.length - 1] || "";
    if (!last) return 0;
    const from = new Date(Date.parse(`${last}T00:00:00Z`) - 365 * 86400000).toISOString().slice(0, 10);
    return rows.filter((r) => r.platform !== "TV" && r.date > from && r.date <= last).reduce((a, r) => a + (r.views || 0), 0);
  }, [rows]);

  const growth = (a: SocialAccount) => {
    const now = currentFollowers(a, stats[a.id]);
    if (!now || a.source === "manual") return null;
    const then = followersOn(stats[a.id], new Date(Date.parse(`${now.date}T00:00:00Z`) - 30 * 86400000).toISOString().slice(0, 10));
    return then === null ? null : now.value - then;
  };
  const pickedAccount = shown.find((a) => a.id === picked);
  const series = useMemo(
    () => (pickedAccount ? Object.entries(stats[pickedAccount.id]?.series || {}).sort().map(([date, value]) => ({ date, value })) : []),
    [pickedAccount, stats],
  );

  return (
    <article className="panel full followers-board-panel" id="followers">
      <div className="panel-head">
        <div>
          <h2>ผู้ติดตาม</h2>
          <p>ผู้ติดตามของทุกบัญชี · ตัวเลขจาก Metricool / YouTube อัปเดตทุกวันพร้อม sync · “{PENDING}” = บัญชีที่ยังไม่ได้ต่อ API ตัวเลขกรอกโดยผู้ดูแล</p>
        </div>
        <div className="ranking-controls">
          <div className="segmented">
            <button className={view === "platform" ? "active" : ""} onClick={() => pickView("platform")}>
              จัดตามแพลตฟอร์ม
            </button>
            <button className={view === "group" ? "active" : ""} onClick={() => pickView("group")}>
              จัดตามรายการ
            </button>
          </div>
          {isAdmin && openSettings && (
            <button className="tv-add" onClick={openSettings}>
              <Settings size={14} /> ตั้งค่าบัญชี
            </button>
          )}
          <button className="tv-add" onClick={() => drawBoard(groups, view, stats, total, views12, updated)} disabled={!shown.length}>
            <Download size={14} /> ดาวน์โหลด PNG
          </button>
        </div>
      </div>

      {error && <p className="growth-notice warn">โหลดข้อมูลไม่สำเร็จ: {error}</p>}
      {accounts === null && !error && <p className="growth-notice">กำลังโหลด…</p>}
      {accounts && !shown.length && (
        <p className="growth-notice">ยังไม่มีบัญชี{isAdmin ? " · กด “ตั้งค่าบัญชี” แล้วเลือก “เริ่มจากรายการตั้งต้น”" : " · รอผู้ดูแลระบบตั้งค่า"}</p>
      )}

      {shown.length > 0 && (
        <div className="followers-board">
          <div className="followers-hero">
            <div>
              <strong>{shortCount(total)}</strong>
              <span className="followers-total-label">Online platform followers and subscribers</span>
              <small>
                {full(total)} · {shown.length} บัญชี{updated ? ` · ข้อมูลถึง ${dayTh(updated)}` : ""}
                {pending.length ? ` · รวมตัวเลข${PENDING} ${pending.length} บัญชี (${full(pendingTotal)})` : ""}
              </small>
            </div>
            <div className="followers-views">
              Total online view
              <b>{shortCount(views12)} views / year</b>
              <small>วิวของโพสต์ 12 เดือนล่าสุดในระบบ</small>
            </div>
          </div>

          {groups.map((g) => (
            <section key={g.key} className="followers-group">
              <header>
                <span>
                  {view === "platform" && <i className="followers-dot" style={{ background: PLATFORM_COLOR[g.key as SocialPlatform] }} />}
                  {g.label}
                </span>
                <small>
                  {full(g.total)} · {g.accounts.length} บัญชี
                </small>
              </header>
              <div className="followers-grid">
                {g.accounts.map((a) => {
                  const now = currentFollowers(a, stats[a.id]);
                  const gr = growth(a);
                  const problem = a.source !== "manual" && stats[a.id]?.error;
                  return (
                    <button key={a.id} className={`followers-card ${picked === a.id ? "active" : ""}`} onClick={() => setPicked(picked === a.id ? "" : a.id)} title={problem || ""}>
                      {a.logo ? <img src={a.logo} alt="" className="followers-logo" /> : <span className="followers-logo text">{initials(a.name)}</span>}
                      <span className="followers-body">
                        <span className="followers-num">{now ? full(now.value) : "–"}</span>
                        <span className="followers-name">
                          {view === "group" && (
                            <span className="followers-pill" style={{ background: PLATFORM_COLOR[a.platform] }}>
                              {PLATFORM_LABEL[a.platform]}
                            </span>
                          )}
                          <span className="followers-title">{a.name}</span>
                        </span>
                        <span className="followers-meta">
                          {a.source === "manual" ? (
                            <span className="followers-manual" title={a.manualDate ? `กรอกเมื่อ ${dayTh(a.manualDate)}` : ""}>
                              {PENDING}
                            </span>
                          ) : gr !== null ? (
                            <span className={gr >= 0 ? "up" : "down"}>{`${gr >= 0 ? "+" : ""}${full(gr)} ใน 30 วัน`}</span>
                          ) : problem ? (
                            <span className="down">ดึงไม่ได้</span>
                          ) : (
                            <span>{now ? dayTh(now.date) : "รอ sync"}</span>
                          )}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      {pickedAccount && (
        <div className="followers-detail">
          <h3>
            {pickedAccount.name} · {PLATFORM_LABEL[pickedAccount.platform]} · ผู้ติดตามรายวัน
          </h3>
          {series.length > 1 ? (
            <div className="chart-md">
              <ResponsiveContainer>
                <LineChart data={series}>
                  <CartesianGrid vertical={false} stroke="#e8edf5" />
                  <XAxis dataKey="date" tickFormatter={dateLabel} tick={{ fontSize: 11 }} minTickGap={30} />
                  <YAxis tick={{ fontSize: 11 }} width={70} tickFormatter={(v) => shortCount(Number(v))} domain={["auto", "auto"]} />
                  <Tooltip labelFormatter={(v) => dateLabel(String(v))} formatter={(v) => [full(Number(v)), "ผู้ติดตาม"]} />
                  <Line type="monotone" dataKey="value" stroke={PLATFORM_COLOR[pickedAccount.platform]} strokeWidth={2.5} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="ranking-empty">
              {pickedAccount.source === "manual" ? `${PENDING}: ยังไม่ได้ต่อ API · ตัวเลขกรอกเมื่อ ${dayTh(pickedAccount.manualDate || "")}` : "ยังมีข้อมูลไม่พอทำกราฟ"}
            </p>
          )}
        </div>
      )}
    </article>
  );
}

/** The board as a PNG in the chosen grouping (drawn on a canvas, so it looks the same everywhere). */
async function drawBoard(groups: Group[], view: View, stats: Record<string, AccountStat>, total: number, views12: number, updated: string) {
  const cols = 3;
  const cardW = 380;
  const cardH = 92;
  const gap = 14;
  const pad = 40;
  const heroH = 150;
  const headH = 44;
  const W = pad * 2 + cols * cardW + (cols - 1) * gap;
  const bodyH = groups.reduce((h, g) => h + headH + Math.ceil(g.accounts.length / cols) * (cardH + gap), 0);
  const H = pad * 2 + heroH + bodyH;
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  ctx.fillStyle = "#0b1020";
  ctx.fillRect(0, 0, W, H);
  const font = (size: number, weight = 700) => `${weight} ${size}px "Noto Sans Thai", "Segoe UI", sans-serif`;
  const all = groups.flatMap((g) => g.accounts);
  const logos = new Map(
    await Promise.all(
      all.map(
        (a) =>
          new Promise<[string, HTMLImageElement | null]>((resolve) => {
            if (!a.logo) return resolve([a.id, null]);
            const img = new Image();
            img.onload = () => resolve([a.id, img]);
            img.onerror = () => resolve([a.id, null]);
            img.src = a.logo;
          }),
      ),
    ),
  );

  // Hero: the total and the views.
  ctx.fillStyle = "#ff3b3f";
  ctx.font = font(84, 900);
  ctx.fillText(shortCount(total), pad, pad + 78);
  const tw = ctx.measureText(shortCount(total)).width;
  ctx.fillStyle = "#ffffff";
  ctx.font = font(26, 900);
  ctx.fillText("ONLINE PLATFORM", pad + tw + 24, pad + 42);
  ctx.font = font(20, 700);
  ctx.fillText("Followers and Subscribers", pad + tw + 24, pad + 74);
  ctx.textAlign = "right";
  ctx.fillStyle = "#ffcc33";
  ctx.font = font(20, 700);
  ctx.fillText("Total online view", W - pad, pad + 42);
  ctx.font = font(30, 900);
  ctx.fillText(`${shortCount(views12)} Views/Year`, W - pad, pad + 80);
  ctx.fillStyle = "#8b93a7";
  ctx.font = font(13, 500);
  ctx.fillText(updated ? `ข้อมูลถึง ${dayTh(updated)} · ${PENDING} = ยังไม่ได้ต่อ API` : "", W - pad, pad + 110);
  ctx.textAlign = "left";

  let y = pad + heroH;
  for (const g of groups) {
    ctx.fillStyle = "#ffffff";
    ctx.font = font(20, 800);
    ctx.fillText(g.label, pad, y + 26);
    ctx.fillStyle = "#8b93a7";
    ctx.font = font(14, 600);
    ctx.textAlign = "right";
    ctx.fillText(`${full(g.total)} · ${g.accounts.length} บัญชี`, W - pad, y + 26);
    ctx.textAlign = "left";
    y += headH;
    g.accounts.forEach((a, i) => {
      const x = pad + (i % cols) * (cardW + gap);
      const cy = y + Math.floor(i / cols) * (cardH + gap);
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.roundRect(x, cy, cardW, cardH, 14);
      ctx.fill();
      const img = logos.get(a.id);
      if (img) ctx.drawImage(img, x + 12, cy + 12, 68, 68);
      else {
        ctx.fillStyle = "#eef1f6";
        ctx.fillRect(x + 12, cy + 12, 68, 68);
        ctx.fillStyle = "#43506a";
        ctx.font = font(16);
        ctx.textAlign = "center";
        ctx.fillText(initials(a.name), x + 46, cy + 52);
        ctx.textAlign = "left";
      }
      const now = currentFollowers(a, stats[a.id]);
      ctx.fillStyle = "#e0262b";
      ctx.font = font(28, 800);
      ctx.fillText(now ? full(now.value) : "–", x + 94, cy + 42);
      let tx = x + 94;
      if (view === "group") {
        ctx.fillStyle = PLATFORM_COLOR[a.platform];
        ctx.beginPath();
        ctx.roundRect(tx, cy + 54, 74, 22, 6);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.font = font(12);
        ctx.textAlign = "center";
        ctx.fillText(PLATFORM_LABEL[a.platform], tx + 37, cy + 70);
        ctx.textAlign = "left";
        tx += 82;
      }
      if (a.source === "manual") {
        ctx.fillStyle = "#fff4d6";
        ctx.beginPath();
        ctx.roundRect(x + cardW - 92, cy + 12, 80, 22, 6);
        ctx.fill();
        ctx.fillStyle = "#7a5200";
        ctx.font = font(12);
        ctx.textAlign = "center";
        ctx.fillText(PENDING, x + cardW - 52, cy + 28);
        ctx.textAlign = "left";
      }
      ctx.fillStyle = "#1f2533";
      ctx.font = font(16, 500);
      let name = a.name;
      const room = x + cardW - 14 - tx;
      while (ctx.measureText(name).width > room && name.length > 3) name = name.slice(0, -2);
      ctx.fillText(name === a.name ? name : `${name}…`, tx, cy + 71);
    });
    y += Math.ceil(g.accounts.length / cols) * (cardH + gap);
  }
  const link = document.createElement("a");
  link.download = `followers-${view}-${updated || "board"}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
}
