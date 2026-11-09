"use client";
// รายงานรายเดือน → one live page on likes and comments: totals against last month,
// the most liked and most commented clips, the level on each platform, topic types
// and a few plain-language highlights. Numbers from lib/dashboard/engagementReport.ts.
import { useMemo } from "react";
import { Lightbulb, MessageCircle, ThumbsUp } from "lucide-react";
import type { RecordRow } from "@/lib/dashboard/types";
import { compact, num } from "@/lib/dashboard/format";
import { PLATFORM_COLORS } from "@/lib/dashboard/constants";
import { change } from "@/lib/dashboard/platformReport";
import { MIN_TOPIC_POSTS, engageTotals, platformEngage, talkClip, topEngaged, topicEngage } from "@/lib/dashboard/engagementReport";
import { Growth } from "@/components/dashboard/shared/Growth";

const COLORS: Record<string, string> = { ...PLATFORM_COLORS, TikTok: "#0f172a" };
const LIKE = "#2563eb";
const COMMENT = "#ea580c";
/** Titles carry hashtags and long captions: the first words only, as the slide has room for. */
const short = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n).trim()}…` : s);
const rate = (v: number | null) => (v === null ? "-" : v < 10 ? v.toFixed(1) : num(Math.round(v)));

function TopList({ rows, by }: { rows: RecordRow[]; by: "likes" | "comments" }) {
  const isLike = by === "likes";
  return (
    <article className="pi-card eg-top">
      <h3>
        {isLike ? <ThumbsUp size={16} color={LIKE} /> : <MessageCircle size={16} color={COMMENT} />} คลิปที่คน{isLike ? " Like " : "คอมเมนต์"}มากที่สุด
      </h3>
      {rows.length ? (
        <ol>
          {rows.map((r, i) => (
            <li key={`${r.platform}|${r.url || r.topic}|${i}`}>
              <b className="pi-rank">{i + 1}</b>
              <span className="eg-clip">
                {r.url ? (
                  <a href={r.url} target="_blank" rel="noreferrer">
                    {r.topic || "ไม่ระบุประเด็น"}
                  </a>
                ) : (
                  r.topic || "ไม่ระบุประเด็น"
                )}
                <small>
                  <i style={{ background: COLORS[r.platform] }} /> {r.platform} · {compact(r.views)} วิว · {rate(r.views ? (r[by] / r.views) * 1000 : null)} ต่อ 1,000 วิว
                </small>
              </span>
              <b className="eg-num" style={{ color: isLike ? LIKE : COMMENT }}>
                {compact(r[by])}
              </b>
            </li>
          ))}
        </ol>
      ) : (
        <p className="ps-muted">ไม่มีข้อมูลในเดือนนี้</p>
      )}
    </article>
  );
}

export function EngagementReport({ cur, prev, compareText }: { cur: RecordRow[]; prev: RecordRow[]; compareText: string }) {
  const t = useMemo(() => engageTotals(cur), [cur]);
  const tp = useMemo(() => (prev.length ? engageTotals(prev) : null), [prev]);
  const likes = useMemo(() => topEngaged(cur, "likes", 4), [cur]);
  const comments = useMemo(() => topEngaged(cur, "comments", 4), [cur]);
  const plats = useMemo(() => platformEngage(cur), [cur]);
  const topics = useMemo(() => topicEngage(cur).slice(0, 5), [cur]);
  const talk = useMemo(() => talkClip(cur), [cur]);

  const tiles = [
    { label: "Like รวม", now: t.likes, before: tp?.likes ?? null, f: compact, color: LIKE },
    { label: "คอมเมนต์รวม", now: t.comments, before: tp?.comments ?? null, f: compact, color: COMMENT },
    { label: "Like ต่อ 1,000 วิว", now: t.likesPer1k, before: tp?.likesPer1k ?? null, f: rate, color: LIKE },
    { label: "คอมเมนต์ต่อ 1,000 วิว", now: t.commentsPer1k, before: tp?.commentsPer1k ?? null, f: rate, color: COMMENT },
  ];
  const maxLike = Math.max(0, ...plats.map((p) => p.likesPer1k || 0));
  const maxComment = Math.max(0, ...plats.map((p) => p.commentsPer1k || 0));
  const topLike = [...plats].sort((a, b) => (b.likesPer1k || 0) - (a.likesPer1k || 0))[0];
  const topTalkPlat = [...plats].sort((a, b) => (b.commentsPer1k || 0) - (a.commentsPer1k || 0))[0];
  const topTalkTopic = [...topics].sort((a, b) => (b.commentsPer1k || 0) - (a.commentsPer1k || 0))[0];
  const topLikeTopic = [...topics].sort((a, b) => (b.likesPer1k || 0) - (a.likesPer1k || 0))[0];
  const commentChange = change(t.commentsPer1k, tp?.commentsPer1k ?? null);

  const highlights: string[] = [];
  if (talk)
    highlights.push(
      `คลิปชวนคุยที่สุด: “${short(talk.row.topic || "ไม่ระบุประเด็น")}” (${talk.row.platform}) ได้ ${rate(talk.commentsPer1k)} คอมเมนต์ต่อ 1,000 วิว จาก ${compact(talk.row.views)} วิว`,
    );
  if (topTalkTopic) highlights.push(`ประเภทที่คนอยากแสดงความเห็น: “${topTalkTopic.topicType}” ${rate(topTalkTopic.commentsPer1k)} คอมเมนต์ต่อ 1,000 วิว`);
  if (topLikeTopic) highlights.push(`ประเภทที่คนกด Like ง่ายที่สุด: “${topLikeTopic.topicType}” ${rate(topLikeTopic.likesPer1k)} Like ต่อ 1,000 วิว`);
  if (topLike && topTalkPlat)
    highlights.push(
      topLike.platform === topTalkPlat.platform
        ? `${topLike.platform} คนมีส่วนร่วมมากที่สุดทั้ง Like และคอมเมนต์ (เทียบต่อวิว)`
        : `คนกด Like ต่อวิวมากที่สุดบน ${topLike.platform} · คอมเมนต์ต่อวิวมากที่สุดบน ${topTalkPlat.platform}`,
    );
  if (commentChange !== null)
    highlights.push(`คอมเมนต์ต่อ 1,000 วิว ${commentChange >= 0 ? "เพิ่มขึ้น" : "ลดลง"} ${Math.abs(commentChange * 100).toFixed(0)}% จากเดือนก่อน`);

  return (
    <div className="eg-page">
      <div className="pt-kpis">
        {tiles.map((x) => (
          <div key={x.label} className="pi-card pt-kpi" style={{ borderTop: `2px solid ${x.color}` }}>
            <small>{x.label}</small>
            <b>{x.now === null ? "-" : x.f(x.now)}</b>
            <Growth value={change(x.now, x.before)} title={compareText} label="เทียบเดือนก่อน" />
          </div>
        ))}
      </div>

      <div className="eg-grid3">
        <TopList rows={likes} by="likes" />
        <TopList rows={comments} by="comments" />
        <article className="pi-card eg-level">
          <h3>ระดับ Like · คอมเมนต์ แต่ละแพลตฟอร์ม</h3>
          <p className="ps-muted">
            ต่อ 1,000 วิว · แถบบน <b style={{ color: LIKE }}>Like</b> · แถบล่าง <b style={{ color: COMMENT }}>คอมเมนต์</b> · ยิ่งยาวคนยิ่งมีส่วนร่วม
          </p>
          {plats.map((p) => (
            <div key={p.platform} className="eg-plat">
              <span className="eg-plat-name">
                <i style={{ background: COLORS[p.platform] }} /> {p.platform}
              </span>
              <span className="eg-bar">
                <span style={{ width: maxLike ? `${((p.likesPer1k || 0) / maxLike) * 100}%` : 0, background: LIKE }} />
              </span>
              <b style={{ color: LIKE }}>{rate(p.likesPer1k)}</b>
              <span className="eg-bar">
                <span style={{ width: maxComment ? `${((p.commentsPer1k || 0) / maxComment) * 100}%` : 0, background: COMMENT }} />
              </span>
              <b style={{ color: COMMENT }}>{rate(p.commentsPer1k)}</b>
            </div>
          ))}
        </article>
      </div>

      <div className="eg-grid2">
        <article className="pi-card">
          <h3>ประเภทข่าวที่คน Like · คอมเมนต์เยอะ</h3>
          <p className="ps-muted">เรียงตาม Like + คอมเมนต์รวม · ประเภทที่มีอย่างน้อย {MIN_TOPIC_POSTS} โพสต์ · ตัวเลขสีเข้ม = สูงสุดของคอลัมน์</p>
          <table className="eg-table">
            <thead>
              <tr>
                <th>ประเภท</th>
                <th className="num">โพสต์</th>
                <th className="num">Like</th>
                <th className="num">คอมเมนต์</th>
                <th className="num">Like /1K วิว</th>
                <th className="num">คอมเมนต์ /1K วิว</th>
              </tr>
            </thead>
            <tbody>
              {topics.map((x) => (
                <tr key={x.topicType}>
                  <td>{x.topicType}</td>
                  <td className="num">{num(x.posts)}</td>
                  <td className="num">{compact(x.likes)}</td>
                  <td className="num">{compact(x.comments)}</td>
                  <td className={`num${x === topLikeTopic ? " eg-best like" : ""}`}>{rate(x.likesPer1k)}</td>
                  <td className={`num${x === topTalkTopic ? " eg-best comment" : ""}`}>{rate(x.commentsPer1k)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>
        <article className="pi-card eg-insight">
          <h3>
            <Lightbulb size={16} color="#ca8a04" /> จุดน่าสนใจ
          </h3>
          {highlights.length ? (
            <ul>
              {highlights.slice(0, 4).map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
          ) : (
            <p className="ps-muted">ข้อมูลยังไม่พอ</p>
          )}
          <p className="ps-muted eg-foot">
            Like ของ Facebook = reaction ทุกแบบ · “ชวนคุย” เลือกจากคลิปที่วิวไม่ต่ำกว่าค่ากลางของแพลตฟอร์ม
          </p>
        </article>
      </div>
    </div>
  );
}
