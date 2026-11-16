// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import * as webpush from "jsr:@negrel/webpush";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const SUPABASE_URL =
  Deno.env.get("SUPABASE_URL") || "https://mvuetclsmbmjwakwlvwi.supabase.co";
const SUPABASE_KEY =
  Deno.env.get("SUPABASE_SECRET_KEY") ||
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
  Deno.env.get("SUPABASE_ANON_KEY") ||
  "sb_publishable_6n8q4lq47EOPoDm9OOnNcw_Zi4L0qck";

// Chaves VAPID P-256 (emparelhadas com VAPID_PUBLIC_KEY em js/config.js)
const EXPORTED_VAPID_KEYS: webpush.ExportedVapidKeys = {
  publicKey: {
    kty: "EC",
    crv: "P-256",
    x: "noj2dhyl6b8puIPc7jIFqy3AuFjvkYu_whGw0WwjdnQ",
    y: "VR7XGJZ4vz8JEy8TmIYWGHyC56fM-RBHusedytQSiSM",
    key_ops: ["verify"],
    ext: true,
  },
  privateKey: {
    kty: "EC",
    crv: "P-256",
    x: "noj2dhyl6b8puIPc7jIFqy3AuFjvkYu_whGw0WwjdnQ",
    y: "VR7XGJZ4vz8JEy8TmIYWGHyC56fM-RBHusedytQSiSM",
    d: "-fJexdrRKQPYX5e5dUTUTCdApSA9BJzNf-mBPZjOCfI",
    key_ops: ["sign"],
    ext: true,
  },
};

let appServerPromise: Promise<webpush.ApplicationServer> | null = null;
function getAppServer() {
  if (!appServerPromise) {
    appServerPromise = webpush
      .importVapidKeys(EXPORTED_VAPID_KEYS, { extractable: false })
      .then((vapidKeys) =>
        webpush.ApplicationServer.new({
          contactInformation: "mailto:agenda@wabisabi.app",
          vapidKeys,
        })
      );
  }
  return appServerPromise;
}

async function checkAndNotifyFinishedBlocks(defaultTzOffset = 0) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // 1. Obter subscrições Web Push registadas pelo iPhone
  const { data: subscriptions } = await supabase
    .from("push_subscriptions")
    .select("*");

  // Determinar fuso horário local do telemóvel (ex: +420 para UTC+7, 0 para Lisboa)
  const subTz = subscriptions?.[0]?.subscription_json?.tz_offset_minutes;
  const tzOffsetMin =
    typeof subTz === "number"
      ? subTz
      : Number(Deno.env.get("TIMEZONE_OFFSET_MINUTES") ?? defaultTzOffset);

  const now = new Date(Date.now() + tzOffsetMin * 60_000);
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const todayStr = `${yyyy}-${mm}-${dd}`;
  const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();

  // 2. Procurar blocos de hoje que já terminaram, sem avaliação e ainda não notificados
  const { data: finishedBlocks, error: blocksErr } = await supabase
    .from("category_blocks")
    .select("*")
    .eq("date_str", todayStr)
    .lte("end_minutes", currentMinutes)
    .is("rating", null)
    .is("notified_at", null);

  if (blocksErr) throw blocksErr;

  let sentCount = 0;
  const appServer = await getAppServer();

  for (const block of finishedBlocks || []) {
    const payload = JSON.stringify({
      title: `${String(block.category).toLowerCase()} concluída`,
      body: block.task_name
        ? `${String(block.task_name).toLowerCase()} · avaliar de 1 a 5 estrelas`
        : "toque para avaliar o bloco de 1 a 5 estrelas",
      blockId: block.id,
    });

    if (subscriptions && subscriptions.length > 0) {
      for (const subRow of subscriptions) {
        const subJson = subRow.subscription_json;
        if (!subJson?.endpoint || !subJson?.keys) continue;
        try {
          const subscriber = appServer.subscribe({
            endpoint: subJson.endpoint,
            keys: subJson.keys,
          });
          await subscriber.pushTextMessage(payload, {});
          sentCount++;
        } catch (pushErr) {
          console.warn("Erro ao enviar Web Push:", pushErr);
        }
      }
    }

    await supabase
      .from("category_blocks")
      .update({ notified_at: new Date().toISOString() })
      .eq("id", block.id);
  }

  return {
    ok: true,
    todayStr,
    currentMinutes,
    tzOffsetMin,
    subscriptions_count: subscriptions?.length || 0,
    blocks_finished: (finishedBlocks || []).map((b) => b.id),
    notifications_sent: sentCount,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch (_) {}

    const tzOffset =
      typeof body.tz_offset_minutes === "number" ? body.tz_offset_minutes : 0;

    const result = await checkAndNotifyFinishedBlocks(tzOffset);

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
