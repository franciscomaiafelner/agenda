// ============================================================================
// SUPABASE EDGE FUNCTION: notify-finished-blocks
// Verifica blocos de categoria que acabaram de terminar e envia Web Push
// para o telemóvel para avaliar o bloco de 0 a 5 estrelas.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SECRET_KEY =
  Deno.env.get('SUPABASE_SECRET_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY') || '';
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY') || '';
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:agenda@wabisabi.app';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

Deno.serve(async (req) => {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

    // Hora atual (ajustável ao fuso horário via variável TIMEZONE_OFFSET_MINUTES, default 0 / Lisboa)
    const tzOffsetMin = Number(Deno.env.get('TIMEZONE_OFFSET_MINUTES') || '0');
    const now = new Date(Date.now() + tzOffsetMin * 60_000);
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const todayStr = `${yyyy}-${mm}-${dd}`;
    const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();

    // 1. Procurar blocos de hoje que já terminaram (end_minutes <= currentMinutes),
    //    ainda sem avaliação (rating is null) e ainda não notificados (notified_at is null)
    const { data: finishedBlocks, error: blocksErr } = await supabase
      .from('category_blocks')
      .select('*')
      .eq('date_str', todayStr)
      .lte('end_minutes', currentMinutes)
      .is('rating', null)
      .is('notified_at', null);

    if (blocksErr) throw blocksErr;

    if (!finishedBlocks || finishedBlocks.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, notified: 0, message: 'nenhum bloco pendente de notificação' }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 2. Obter subscrições Web Push do telemóvel registadas na tabela push_subscriptions
    const { data: subscriptions } = await supabase
      .from('push_subscriptions')
      .select('*');

    let sentCount = 0;

    for (const block of finishedBlocks) {
      const payload = JSON.stringify({
        title: `${String(block.category).toLowerCase()} concluída`,
        body: block.task_name
          ? `${String(block.task_name).toLowerCase()} · avaliar de 0 a 5 estrelas`
          : 'toque para avaliar o bloco de 0 a 5 estrelas',
        blockId: block.id
      });

      if (subscriptions && subscriptions.length > 0 && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
        for (const sub of subscriptions) {
          try {
            await webpush.sendNotification(sub.subscription_json, payload);
            sentCount++;
          } catch (pushErr) {
            console.warn('erro ao enviar web push:', pushErr);
          }
        }
      }

      // 3. Marcar o bloco como notificado para não repetir a notificação
      await supabase
        .from('category_blocks')
        .update({ notified_at: new Date().toISOString() })
        .eq('id', block.id);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        blocks_finished: finishedBlocks.map((b) => b.id),
        notifications_sent: sentCount
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
});
