// One AI turn for a conversation:
//   gate (bot mode?) -> prompt + context + history -> tool loop -> outbound guard
//   -> split into short messages -> re-check bot mode -> queue with a human-like delay.
// Handovers decided by tools (discount below the floor, out of area, customer asks)
// are applied here, so the model can't skip them.
const { query, withTx } = require('../db/pool');
const logger = require('../lib/logger');
const { canBotReply, switchMode } = require('../conversations/handover.service');
const { enqueueMessage } = require('../whatsapp/outbound.service');
const bus = require('../realtime/bus');
const provider = require('./provider');
const { TOOLS, toolSpecs } = require('./tools/definitions');
const { HANDLERS } = require('./tools/handlers');
const { checkPrices, amountsInResult, splitMessage, stripInternal } = require('./guard');
const ctxBuilder = require('./context');

const MAX_FIXES = 1;   // the model gets one chance to correct a blocked or over-long reply

async function loadConfig(tenantId) {
  const [{ rows: [cfg] }, { rows: tools }] = await Promise.all([
    query(`SELECT * FROM ai_agent_config WHERE tenant_id = $1`, [tenantId]),
    query(`SELECT name, description, config, is_enabled FROM ai_tools WHERE tenant_id = $1 ORDER BY sort_order`, [tenantId]),
  ]);
  return { cfg, tools };
}

async function recordToolCall(ctx, name, args, result, ok, error, ms) {
  await query(
    `INSERT INTO ai_tool_calls (tenant_id, ai_run_id, tool_name, arguments, result, success, error_message, duration_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [ctx.tenantId, ctx.runId, name, JSON.stringify(args ?? {}), result == null ? null : JSON.stringify(result), ok, error, ms]);
}

async function runTool(call, ctx) {
  const name = call.function?.name;
  const started = Date.now();
  let args = {};
  try {
    args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    await recordToolCall(ctx, name || 'unknown', { raw: String(call.function?.arguments).slice(0, 500) }, null, false, 'invalid JSON arguments', 0);
    return { error: 'Arguments were not valid JSON. Try again.' };
  }
  if (!HANDLERS[name] || !ctx.enabledTools.has(name)) {
    await recordToolCall(ctx, /^[a-z_]{2,64}$/.test(name || '') ? name : 'unknown', args, null, false, 'unknown or disabled tool', 0);
    return { error: `Tool ${name} is not available.` };
  }
  const parsed = TOOLS[name].schema.safeParse(args);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ');
    await recordToolCall(ctx, name, args, null, false, msg, 0);
    return { error: `Invalid arguments: ${msg}` };
  }
  try {
    const result = await HANDLERS[name](parsed.data, ctx);
    amountsInResult(result).forEach((v) => ctx.allowed.add(v));
    await recordToolCall(ctx, name, parsed.data, result, !result?.error, result?.error || null, Date.now() - started);
    return result;
  } catch (err) {
    logger.error('agent tool failed', { tool: name, error: err.message });
    await recordToolCall(ctx, name, parsed.data, null, false, String(err.message).slice(0, 500), Date.now() - started);
    return { error: 'The tool failed. Do not guess; if you cannot continue, call handover_to_human.' };
  }
}

/** Switch to a person: mode change + internal note for the team + message to the customer. */
async function applyHandover(ctx, h) {
  await withTx(async (c) => {
    const { rows: [cv] } = await c.query(`SELECT handling_mode, contact_id FROM conversations WHERE id = $1`, [ctx.conversationId]);
    if (cv.handling_mode !== 'bot') return;
    await switchMode(c, {
      tenantId: ctx.tenantId, conversationId: ctx.conversationId, to: 'human', trigger: h.trigger, reason: h.reason.slice(0, 300),
      metadata: { ...(h.metadata || {}), ai_run_id: ctx.runId },
    });
    await c.query(
      `INSERT INTO messages (tenant_id, conversation_id, contact_id, direction, sender_type, message_type, body, status, is_internal_note, ai_run_id)
       VALUES ($1,$2,$3,'outbound','system','text',$4,'sent',true,$5)`,
      [ctx.tenantId, ctx.conversationId, cv.contact_id, `🤖 Handed over: ${h.reason}${h.summary ? `\n${h.summary}` : ''}`.slice(0, 1500), ctx.runId]);
    if (ctx.cfg.handover_message) {
      await enqueueMessage({ tenantId: ctx.tenantId, conversationId: ctx.conversationId, type: 'text', content: { text: ctx.cfg.handover_message }, senderType: 'system', aiRunId: ctx.runId }, c)
        .catch((err) => logger.warn('handover message not queued', { error: err.message }));
    }
    await bus.publish({ tenantId: ctx.tenantId, type: 'message.new', conversation_id: ctx.conversationId }, c);
  });
}

/** Human-like pacing. The model's own thinking time counts towards the delay. */
function delays(cfg, sandbox, startedAt) {
  if (sandbox) return () => 0;
  const min = cfg.response_delay_min_ms; const max = Math.max(min, cfg.response_delay_max_ms);
  const target = min + Math.floor(Math.random() * (max - min + 1));
  let at = 0;
  let first = true;
  return () => {
    if (first) { first = false; at = Math.max(0, target - (Date.now() - startedAt)); return at; }
    at += 1200;            // next bubble a moment later, like someone typing
    return at;
  };
}

/**
 * @param {object} p
 * @param {string} p.tenantId
 * @param {string} p.conversationId
 * @param {string} [p.triggerMessageId]
 * @param {boolean} [p.sandbox]       test console: no delays (messages never reach WhatsApp anyway)
 * @param {Function} [p.llm]          injectable for tests: (cfg, messages, tools) => provider.chat result
 * @returns {Promise<{run_id:string|null, outcome:string, messages:number, blocked_reason?:string}>}
 */
async function runTurn({ tenantId, conversationId, triggerMessageId = null, sandbox = false, llm = provider.chat }) {
  const { cfg, tools } = await loadConfig(tenantId);
  const gate = await canBotReply(conversationId);
  if (!gate.allowed) return { run_id: null, outcome: gate.reason === 'bot_disabled' ? 'skipped_disabled' : 'skipped_human', messages: 0 };

  const started = Date.now();
  const { rows: [run] } = await query(
    `INSERT INTO ai_runs (tenant_id, conversation_id, trigger_message_id, ai_agent_config_version, provider, model)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [tenantId, conversationId, triggerMessageId, cfg.version, cfg.provider, cfg.model]);

  const ctx = {
    tenantId, conversationId, runId: run.id, sandbox, cfg,
    toolConfig: Object.fromEntries(tools.map((t) => [t.name, t.config])),
    enabledTools: new Set(tools.filter((t) => t.is_enabled).map((t) => t.name)),
    allowed: await ctxBuilder.allowedAmounts(conversationId),
    handover: null,
    nextDelay: delays(cfg, sandbox, started),
  };
  const usage = { input: 0, cached: 0, output: 0 };
  let iterations = 0; let outcome = 'replied'; let blockedReason = null; let errorMessage = null; let sentCount = 0; let modelUsed = cfg.model;

  try {
    const [hist, block] = await Promise.all([
      ctxBuilder.history(conversationId, cfg.max_history_messages),
      ctxBuilder.contextBlock({ tenantId, conversationId }),
    ]);
    const messages = [
      { role: 'system', content: ctxBuilder.systemPrompt(cfg) },
      { role: 'system', content: `${block.text}\n\nReply rules enforced by the system: at most ${cfg.max_message_chars} characters per message, prices only from tools.` },
      ...ctxBuilder.toChat(hist),
    ];
    if (messages[messages.length - 1]?.role !== 'user') {
      // Nothing new from the customer since our last reply: nothing to answer.
      outcome = 'skipped_human';
      return { run_id: run.id, outcome: 'nothing_to_answer', messages: 0 };
    }
    const specs = toolSpecs(tools);
    let fixes = 0;
    let finalText = null;

    while (iterations < cfg.max_tool_iterations + MAX_FIXES + 1) {
      iterations += 1;
      const res = await llm(cfg, messages, specs);
      modelUsed = res.model || modelUsed;
      usage.input += res.usage.input; usage.cached += res.usage.cached; usage.output += res.usage.output;
      const calls = res.message.tool_calls || [];

      if (calls.length) {
        messages.push({ role: 'assistant', content: res.message.content || '', tool_calls: calls });
        for (const call of calls) {
          const result = ctx.handover ? { skipped: 'handover in progress' } : await runTool(call, ctx);
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        }
        if (ctx.handover) break;
        if (iterations >= cfg.max_tool_iterations) {
          ctx.handover = { trigger: 'bot_stuck', reason: `The AI used ${iterations} tool steps without answering` };
          break;
        }
        continue;
      }

      const text = stripInternal(res.message.content);
      if (!text) {
        // e.g. the model spent its token budget thinking. Never leave the customer without a reply.
        if (fixes < MAX_FIXES) {
          fixes += 1;
          messages.push({ role: 'system', content: 'Your last reply was empty. Reply to the customer now, briefly.' });
          continue;
        }
        ctx.handover = { trigger: 'bot_stuck', reason: 'The AI gave an empty reply twice' };
        break;
      }
      const guard = checkPrices(text, ctx.allowed);
      const parts = splitMessage(text, cfg.max_message_chars);
      const tooLong = parts.length > cfg.max_messages_per_turn;
      if ((!guard.ok || tooLong) && fixes < MAX_FIXES) {
        fixes += 1;
        messages.push({ role: 'assistant', content: text });
        messages.push({
          role: 'system',
          content: !guard.ok
            ? `Your reply was NOT sent: it mentions ${guard.unknown.map((v) => `₹${v.toLocaleString('en-IN')}`).join(', ')}, which no tool returned in this chat. Rewrite it using only prices from tool results (call a tool if you need a price), or leave prices out.`
            : `Your reply was NOT sent: it is too long for WhatsApp. Rewrite it in at most ${cfg.max_messages_per_turn} short messages of ${cfg.max_message_chars} characters.`,
        });
        continue;
      }
      if (!guard.ok) {
        outcome = 'blocked';
        blockedReason = `unknown_price:${guard.unknown.join(',')}`;
        ctx.handover = { trigger: 'system', reason: `AI reply blocked: it mentioned a price no pricing tool issued (${guard.unknown.map((v) => `₹${v.toLocaleString('en-IN')}`).join(', ')})`, metadata: { blocked_text: text.slice(0, 500) } };
        break;
      }
      finalText = text;
      break;
    }

    if (ctx.handover) {
      await applyHandover(ctx, ctx.handover);
      if (outcome !== 'blocked') outcome = 'handover';
    } else if (finalText) {
      // Last check right before sending: a person may have taken over while we were thinking.
      const again = await canBotReply(conversationId);
      if (!again.allowed) {
        outcome = 'skipped_human';
      } else {
        for (const part of splitMessage(finalText, cfg.max_message_chars)) {
          await enqueueMessage({ tenantId, conversationId, type: 'text', content: { text: part }, senderType: 'bot', aiRunId: run.id, delayMs: ctx.nextDelay() });
          sentCount += 1;
        }
      }
    }
    await query(`UPDATE conversations SET bot_stuck_count = 0 WHERE id = $1 AND bot_stuck_count > 0 AND $2`, [conversationId, outcome === 'replied']);
    return { run_id: run.id, outcome, messages: sentCount, ...(blockedReason ? { blocked_reason: blockedReason } : {}) };
  } catch (err) {
    outcome = 'error';
    errorMessage = String(err.message || err).slice(0, 1000);
    logger.error('agent turn failed', { conversationId, error: errorMessage });
    err.runId = run.id;
    throw err;
  } finally {
    const settings = cfg.settings || {};
    await query(
      `UPDATE ai_runs SET outcome = $2, blocked_reason = $3, error_message = $4, model = $5, input_tokens = $6, cached_input_tokens = $7,
              output_tokens = $8, cost_inr = $9, latency_ms = $10, iterations = $11, finished_at = now()
        WHERE id = $1`,
      [run.id, outcome, blockedReason, errorMessage, modelUsed, usage.input, usage.cached, usage.output,
        provider.costInr(usage, cfg.pricing_per_1m, Number(settings.usd_inr) || 84).toFixed(4), Date.now() - started, iterations]);
  }
}

/** The bot failed repeatedly on a conversation: hand it to a person. */
async function markStuck(tenantId, conversationId, reason) {
  const { rows: [r] } = await query(
    `UPDATE conversations cv SET bot_stuck_count = bot_stuck_count + 1 FROM ai_agent_config a
      WHERE cv.id = $1 AND a.tenant_id = cv.tenant_id RETURNING cv.bot_stuck_count, a.stuck_threshold, a.handover_message`, [conversationId]);
  const { cfg } = await loadConfig(tenantId);
  await applyHandover({ tenantId, conversationId, runId: null, cfg }, { trigger: 'bot_stuck', reason: `${reason} (${r?.bot_stuck_count ?? 1} times)` });
}

module.exports = { runTurn, markStuck, applyHandover };
