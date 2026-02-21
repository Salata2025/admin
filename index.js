import express from "express";
import axios from "axios";
import cron from "node-cron";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const PUBLIC_URL = process.env.PUBLIC_URL;
const PORT = Number(process.env.PORT || 8080);

const REPORT_HOUR = Number(process.env.REPORT_HOUR || 21);
const REPORT_TZ = process.env.REPORT_TZ || "Europe/Berlin";

let OWNER_CHAT_ID = process.env.OWNER_CHAT_ID ? String(process.env.OWNER_CHAT_ID) : "";

const TRAE_API_URL = process.env.TRAE_API_URL;
const TRAE_API_KEY = process.env.TRAE_API_KEY;
const TRAE_MODEL = process.env.TRAE_MODEL || "default";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

const TRAE_SYSTEM_PROMPT = `
Ты — AI-аналитик ежедневных сообщений владельца Telegram-ботов.

Вход: список сообщений за день (00:00–23:59 Europe/Berlin).
Каждое сообщение:
{bot_name, chat_id, chat_type, chat_title, user_id, username, full_name, ts_iso, text}

Сделай:
1) Сгруппируй сообщения по chat_id (это один диалог/thread).
2) Для каждого диалога определи:
   - intent: sales_lead | support | billing | partnership | team_ops | spam | other
   - priority: P0 | P1 | P2 | P3 | SPAM
   - summary: 1-2 предложения
   - owner_attention_required: true если P0/P1
   - suggested_reply: если owner_attention_required=true, короткий ответ 1-3 строки
   - next_action: конкретное действие

3) Сформируй общий вечерний отчет в Markdown:
KPI → P0 → P1 → Clients summary → Team/Ops → Owner To-Do (5–10 пунктов).

Правила:
- Не выдумывать факты.
- Если мало данных — other/P3.
- Тон: деловой, короткий.
Выход строго JSON:
{
  "report_markdown": "...",
  "kpi": { "total_messages":0, "total_threads":0, "p0":0, "p1":0, "p2":0, "p3":0, "spam":0, "sales_leads":0 },
  "threads": [
    {
      "chat_id":"",
      "chat_title":"",
      "intent":"",
      "priority":"",
      "summary":"",
      "owner_attention_required":false,
      "suggested_reply":"",
      "next_action":""
    }
  ]
}
`.trim();

function requireSupabase() {
  if (!supabase) {
    throw new Error("Supabase is not configured");
  }
}

async function appendRow(table, values) {
  requireSupabase();

  if (table === "messages") {
    const [
      message_id,
      thread_id,
      bot_name,
      bot_id,
      chat_id,
      chat_type,
      chat_title,
      user_id,
      username,
      full_name,
      ts_iso,
      text,
    ] = values;

    const { error } = await supabase.from("messages").insert({
      message_id,
      thread_id,
      bot_name,
      bot_id,
      chat_id,
      chat_type,
      chat_title,
      user_id,
      username,
      full_name,
      ts_iso,
      text,
    });
    if (error) {
      console.error("Supabase insert messages error", error);
    }
    return;
  }

  if (table === "daily_reports") {
    const [
      report_date,
      generated_ts,
      kpi_total_messages,
      kpi_total_threads,
      kpi_p0,
      kpi_p1,
      kpi_sales_leads,
      top_sources,
      report_markdown,
    ] = values;

    const { error } = await supabase.from("daily_reports").insert({
      report_date,
      generated_ts,
      kpi_total_messages,
      kpi_total_threads,
      kpi_p0,
      kpi_p1,
      kpi_sales_leads,
      top_sources,
      report_markdown,
    });
    if (error) {
      console.error("Supabase insert daily_reports error", error);
    }
    return;
  }
}

async function readRows(table) {
  requireSupabase();
  const { data, error } = await supabase.from(table).select("*");
  if (error) {
    console.error("Supabase read error", table, error);
    return [];
  }
  return data || [];
}

async function tgSendMessage(chatId, text) {
  if (!BOT_TOKEN) {
    console.error("Missing TELEGRAM_BOT_TOKEN");
    return;
  }
  const parts = splitText(text, 3500);
  for (const part of parts) {
    await axios.post(`${TG_API}/sendMessage`, {
      chat_id: chatId,
      text: part,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });
  }
}

function splitText(text, maxLen = 3500) {
  const parts = [];
  let s = text;
  while (s.length > maxLen) {
    let cut = s.lastIndexOf("\n", maxLen);
    if (cut < 1000) cut = maxLen;
    parts.push(s.slice(0, cut));
    s = s.slice(cut);
  }
  if (s.trim().length) parts.push(s);
  return parts;
}

function normalizeIncoming(update) {
  const msg =
    update.message ||
    update.edited_message ||
    update.channel_post ||
    update.edited_channel_post;
  if (!msg) return null;

  const chat = msg.chat || {};
  const from = msg.from || {};
  const ts = msg.date ? new Date(msg.date * 1000).toISOString() : new Date().toISOString();

  const text =
    msg.text ??
    msg.caption ??
    (msg.voice
      ? "[voice]"
      : msg.photo
      ? "[photo]"
      : msg.document
      ? "[document]"
      : msg.sticker
      ? "[sticker]"
      : msg.video
      ? "[video]"
      : "[other]");

  const botName = process.env.BOT_NAME || "";

  const message_id = `tg:${chat.id}:${msg.message_id}`;
  const thread_id = `tg:${chat.id}`;

  const fullName = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();

  return {
    message_id,
    thread_id,
    bot_name: botName,
    bot_id: "",
    chat_id: String(chat.id ?? ""),
    chat_type: String(chat.type ?? ""),
    chat_title: String(chat.title ?? ""),
    user_id: String(from.id ?? ""),
    username: String(from.username ?? ""),
    full_name: fullName,
    ts_iso: ts,
    text: String(text ?? ""),
  };
}

async function handleCommand(normalized) {
  const t = normalized.text.trim();
  if (!t.startsWith("/")) return false;

  if (t.startsWith("/set_owner")) {
    OWNER_CHAT_ID = normalized.chat_id;
    await tgSendMessage(OWNER_CHAT_ID, "Owner set ✅");
    return true;
  }

  if (t.startsWith("/report_now")) {
    if (!OWNER_CHAT_ID) {
      await tgSendMessage(normalized.chat_id, "Owner not set. Use /set_owner");
      return true;
    }
    const report = await buildDailyReportLLM(new Date(), REPORT_TZ);
    await sendReportToOwner(report);
    return true;
  }

  if (t.startsWith("/yesterday")) {
    if (!OWNER_CHAT_ID) {
      await tgSendMessage(normalized.chat_id, "Owner not set. Use /set_owner");
      return true;
    }
    const d = new Date(Date.now() - 24 * 3600 * 1000);
    const report = await buildDailyReportLLM(d, REPORT_TZ);
    await sendReportToOwner(report);
    return true;
  }

  return false;
}

function classifyPriority(text) {
  const s = text.toLowerCase();
  if (/(не работает|сломал(ся|ась)|ошибка|error|500|бан|blocked|оплата|платеж|refund|возврат|срочно|urgent)/.test(s)) {
    return "P0";
  }
  if (/(цена|стоимость|сколько|прайс|заказать|купить|созвон|сроки|deadline|внедрить)/.test(s)) {
    return "P1";
  }
  if (/(идея|фича|добавить|хочу чтобы)/.test(s)) {
    return "P2";
  }
  return "P3";
}

function classifyIntent(text, chatType) {
  const s = text.toLowerCase();
  if (/(оплата|платеж|счет|invoice|refund|возврат)/.test(s)) return "billing";
  if (/(не работает|ошибка|bug|error|сломал(ся|ась))/i.test(s)) return "support";
  if (/(купить|заказать|цена|стоимость|прайс|созвон|консультац)/.test(s)) return "sales_lead";
  if (/(партнер|partnership|collab)/.test(s)) return "partnership";
  if (chatType === "group" || chatType === "supergroup") return "team_ops";
  if (/(spam|казино|инвестируй|free money|airdrop)/.test(s)) return "spam";
  return "other";
}

function formatDateISO(date, tz) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(date)
    .reduce((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function isSameDayTs(tsIso, targetDateISO, tz) {
  const d = new Date(tsIso);
  const day = formatDateISO(d, tz);
  return day === targetDateISO;
}

async function buildDailyReport(dateObj, tz) {
  const targetDate = formatDateISO(dateObj, tz);
  const messages = await readRows("messages");
  const dayMessages = messages.filter((m) => m.ts_iso && isSameDayTs(m.ts_iso, targetDate, tz));

  const enriched = dayMessages.map((m) => {
    const priority = classifyPriority(m.text || "");
    const intent = classifyIntent(m.text || "", m.chat_type || "");
    return { ...m, priority, intent };
  });

  const threads = new Map();
  for (const m of enriched) {
    if (!threads.has(m.thread_id)) threads.set(m.thread_id, []);
    threads.get(m.thread_id).push(m);
  }

  const kpi = {
    date: targetDate,
    total_messages: enriched.length,
    total_threads: threads.size,
    p0: enriched.filter((x) => x.priority === "P0").length,
    p1: enriched.filter((x) => x.priority === "P1").length,
    p2: enriched.filter((x) => x.priority === "P2").length,
    p3: enriched.filter((x) => x.priority === "P3").length,
    spam: enriched.filter((x) => x.intent === "spam").length,
    sales_leads: enriched.filter((x) => x.intent === "sales_lead").length,
  };

  const byChat = {};
  for (const m of enriched) {
    const key = m.chat_title || m.username || m.chat_id || "unknown";
    byChat[key] = (byChat[key] || 0) + 1;
  }
  const topSources = Object.entries(byChat)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  function threadLine(items) {
    const lastItem = items[items.length - 1];
    const title = lastItem.chat_title || lastItem.username || items[0].chat_id;
    const last = (lastItem.text || "").slice(0, 140).replace(/\n/g, " ");
    return `- [${title}] ${last}`;
  }

  const p0Threads = [];
  const p1Threads = [];
  const clientThreads = [];
  const teamThreads = [];

  for (const [, msgs] of threads.entries()) {
    msgs.sort((a, b) => (a.ts_iso > b.ts_iso ? 1 : -1));
    const maxPriority = msgs.some((x) => x.priority === "P0")
      ? "P0"
      : msgs.some((x) => x.priority === "P1")
      ? "P1"
      : msgs.some((x) => x.priority === "P2")
      ? "P2"
      : "P3";
    const intents = msgs.map((x) => x.intent);
    const intent = intents.includes("sales_lead")
      ? "sales_lead"
      : intents.includes("support")
      ? "support"
      : intents.includes("billing")
      ? "billing"
      : intents.includes("team_ops")
      ? "team_ops"
      : intents.includes("partnership")
      ? "partnership"
      : intents.includes("spam")
      ? "spam"
      : "other";

    if (maxPriority === "P0") p0Threads.push(threadLine(msgs));
    else if (maxPriority === "P1") p1Threads.push(threadLine(msgs));

    if (intent === "team_ops") teamThreads.push(threadLine(msgs));
    else if (intent !== "spam") clientThreads.push(threadLine(msgs));
  }

  const topSourcesStr = topSources.map(([k, v]) => `${k}:${v}`).join("; ");

  const reportMarkdown = `# Evening Report — ${targetDate}
 
## KPI 
- Messages: ${kpi.total_messages} 
- Threads: ${kpi.total_threads} 
- P0: ${kpi.p0} | P1: ${kpi.p1} | P2: ${kpi.p2} | P3: ${kpi.p3} | SPAM: ${kpi.spam} 
- Sales leads: ${kpi.sales_leads} 
- Top sources: ${topSourcesStr || "—"} 
 
## P0 (critical) 
${p0Threads.length ? p0Threads.join("\n") : "- —"} 
 
## P1 (hot) 
${p1Threads.length ? p1Threads.join("\n") : "- —"} 
 
## Clients / Requests 
${clientThreads.length ? clientThreads.slice(0, 20).join("\n") : "- —"} 
 
## Team / Ops 
${teamThreads.length ? teamThreads.slice(0, 20).join("\n") : "- —"} 
 
## Owner To-Do (suggested) 
${
  [
    kpi.p0 ? "1) Close P0 threads today (payments/outages)." : null,
    kpi.p1 ? "2) Reply to hot leads with price range + next step." : null,
    kpi.sales_leads ? "3) Ask 3 qualifiers: scope, deadline, budget." : null,
  ]
    .filter(Boolean)
    .map((x) => `- ${x}`)
    .join("\n") || "- —"
} 
`;

  return { targetDate, kpi, topSourcesStr, reportMarkdown };
}

async function callTrae(messagesForDay) {
  if (!TRAE_API_URL || !TRAE_API_KEY) {
    throw new Error("Missing TRAE_API_URL / TRAE_API_KEY");
  }

  const userPayload = JSON.stringify({ messages: messagesForDay });

  const res = await axios.post(
    TRAE_API_URL,
    {
      model: TRAE_MODEL,
      messages: [
        { role: "system", content: TRAE_SYSTEM_PROMPT },
        { role: "user", content: userPayload },
      ],
      temperature: 0.2,
    },
    {
      headers: {
        Authorization: `Bearer ${TRAE_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 60000,
    }
  );

  const content =
    res?.data?.choices?.[0]?.message?.content ??
    res?.data?.output_text ??
    res?.data?.content ??
    "";

  if (!content) throw new Error("Empty Trae response");

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}$/);
    if (!m) throw new Error("Trae response is not valid JSON");
    parsed = JSON.parse(m[0]);
  }

  if (!parsed.report_markdown || !parsed.kpi) {
    throw new Error("Trae JSON missing report_markdown or kpi");
  }

  return parsed;
}

async function buildDailyReportLLM(dateObj, tz) {
  const targetDate = formatDateISO(dateObj, tz);
  const messages = await readRows("messages");
  const dayMessages = messages
    .filter((m) => m.ts_iso && isSameDayTs(m.ts_iso, targetDate, tz))
    .map((m) => ({
      bot_name: m.bot_name || "",
      chat_id: m.chat_id || "",
      chat_type: m.chat_type || "",
      chat_title: m.chat_title || "",
      user_id: m.user_id || "",
      username: m.username || "",
      full_name: m.full_name || "",
      ts_iso: m.ts_iso || "",
      text: m.text || "",
    }));

  const llm = await callTrae(dayMessages);

  return {
    targetDate,
    reportMarkdown: llm.report_markdown,
    kpi: llm.kpi,
    threads: llm.threads || [],
  };
}

async function sendReportToOwner(report) {
  const { targetDate, kpi, reportMarkdown } = report;

  await appendRow("daily_reports", [
    targetDate,
    new Date().toISOString(),
    String(kpi.total_messages ?? 0),
    String(kpi.total_threads ?? 0),
    String(kpi.p0 ?? 0),
    String(kpi.p1 ?? 0),
    String(kpi.sales_leads ?? 0),
    "",
    reportMarkdown,
  ]);

  const parts = splitText(reportMarkdown, 3500);
  for (let i = 0; i < parts.length; i++) {
    const prefix = parts.length > 1 ? `Part ${i + 1}/${parts.length}\n\n` : "";
    await tgSendMessage(OWNER_CHAT_ID, prefix + parts[i]);
  }
}

app.post("/telegram/webhook", async (req, res) => {
  try {
    const update = req.body;
    const normalized = normalizeIncoming(update);
    if (!normalized) {
      return res.sendStatus(200);
    }

    const handled = await handleCommand(normalized);
    if (!handled) {
      await appendRow("messages", [
        normalized.message_id,
        normalized.thread_id,
        normalized.bot_name,
        normalized.bot_id,
        normalized.chat_id,
        normalized.chat_type,
        normalized.chat_title,
        normalized.user_id,
        normalized.username,
        normalized.full_name,
        normalized.ts_iso,
        normalized.text,
      ]);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error", err);
    res.sendStatus(200);
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

async function setWebhook() {
  if (!PUBLIC_URL) throw new Error("Missing PUBLIC_URL");
  const url = `${PUBLIC_URL}/telegram/webhook`;
  await axios.post(`${TG_API}/setWebhook`, { url });
  console.log("Webhook set:", url);
}

if (Number.isFinite(REPORT_HOUR) && REPORT_HOUR >= 0 && REPORT_HOUR <= 23) {
  const cronExpr = `0 0 ${REPORT_HOUR} * * *`;
  cron.schedule(
    cronExpr,
    async () => {
      try {
        if (!OWNER_CHAT_ID) {
          console.log("Owner not set; skip daily report.");
          return;
        }
        const report = await buildDailyReportLLM(new Date(), REPORT_TZ);
        await sendReportToOwner(report);
        console.log("Daily report sent.");
      } catch (e) {
        console.error("Daily report error:", e);
      }
    },
    { timezone: REPORT_TZ }
  );
  console.log(`Daily report scheduled at ${REPORT_HOUR}:00 ${REPORT_TZ}`);
} else {
  console.log("REPORT_HOUR is invalid, cron not scheduled");
}

app.listen(PORT, async () => {
  console.log(`Server running on :${PORT}`);
  try {
    await setWebhook();
  } catch (e) {
    console.error("Webhook setup failed:", e.message);
  }
});
