import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stripJsonc,
  parseJson,
  defaultConfig,
  mergeConfig,
  activePlanId,
  planDisplayName,
  computeTitle,
  isDefaultTitle,
  decideAction,
  emptyState,
  parseState,
  serializeState,
  lastTitleFor,
  updateLastTitle,
} from "../opencode/plugins/core/session-title-core.js";

test("stripJsonc remove comentários mantendo strings", () => {
  const text = `{
  // comentário
  "agents": ["loop-development"], // inline
  "prefix": "// não é comentário",
  "suffix": "x/*y"
}`;
  assert.deepEqual(parseJson(text), { agents: ["loop-development"], prefix: "// não é comentário", suffix: "x/*y" });
  assert.equal(JSON.parse(stripJsonc(text)).prefix, "// não é comentário");
});

test("defaultConfig e mergeConfig", () => {
  assert.deepEqual(defaultConfig(), {
    enabled: true,
    agents: ["loop-development"],
    prefix: "",
    suffix: "",
    mode: "first",
    debug: false,
  });
  const merged = mergeConfig({ enabled: false, prefix: "[", suffix: "]", mode: "sempre", agents: ["a"] });
  assert.equal(merged.enabled, false);
  assert.equal(merged.prefix, "[");
  assert.equal(merged.suffix, "]");
  assert.equal(merged.mode, "first", "mode inválido cai para o default");
  assert.deepEqual(merged.agents, ["a"]);
  assert.equal(mergeConfig(null).enabled, true);
});

test("activePlanId lê active_plan e activePlan", () => {
  assert.equal(activePlanId({ active_plan: "20260808.2246-x" }), "20260808.2246-x");
  assert.equal(activePlanId({ activePlan: "x" }), "x");
  assert.equal(activePlanId(null), null);
  assert.equal(activePlanId({}), null);
});

test("planDisplayName deriva nome legível do id", () => {
  assert.equal(planDisplayName("20260808.2246-login-google"), "Login Google");
  assert.equal(planDisplayName("login-google"), "Login Google");
  assert.equal(planDisplayName("20260808.2246-auth"), "Auth");
  assert.equal(planDisplayName(""), "");
  assert.equal(planDisplayName(null), "");
});

test("computeTitle aplica prefixo e sufixo", () => {
  assert.equal(computeTitle("login-google"), "Login Google");
  assert.equal(computeTitle("login-google", "[", "]"), "[Login Google]");
  assert.equal(computeTitle("", "[", "]"), "");
});

test("isDefaultTitle", () => {
  assert.equal(isDefaultTitle(""), true);
  assert.equal(isDefaultTitle("Nova sessão"), true);
  assert.equal(isDefaultTitle("New session"), true);
  assert.equal(isDefaultTitle("New session - 14:30"), true);
  assert.equal(isDefaultTitle("Login Google"), false);
});

test("decideAction: disabled, agente fora da lista e sem plano", () => {
  assert.equal(decideAction({ config: { enabled: false }, agent: "loop-development", activePlan: "x", currentTitle: "" }).action, "skip");
  assert.equal(decideAction({ config: {}, agent: "implementer", activePlan: "x", currentTitle: "" }).reason, "agent");
  assert.equal(decideAction({ config: {}, agent: "loop-development", activePlan: null, currentTitle: "" }).reason, "no-plan");
  assert.equal(decideAction({ config: {}, agent: "loop-development", activePlan: "x", currentTitle: "X" }).reason, "already");
});

test("decideAction mode first: sobrescreve na 1ª vez e atualiza trocas de plano", () => {
  const base = { config: {}, agent: "loop-development", activePlan: "login-google" };

  // 1ª vez: sobrescreve mesmo que já exista título
  assert.deepEqual(decideAction({ ...base, currentTitle: "Coisa antiga", lastSetTitle: undefined }), {
    action: "set",
    title: "Login Google",
    reason: "first",
  });

  // título ainda é o nosso -> atualiza em troca de plano
  assert.deepEqual(
    decideAction({ ...base, currentTitle: "Login Google", lastSetTitle: "Login Google", activePlan: "nova-feature" }),
    { action: "set", title: "Nova Feature", reason: "update" },
  );

  // título já é o desejado -> skip
  assert.equal(
    decideAction({ ...base, currentTitle: "Login Google", lastSetTitle: "Login Google" }).action,
    "skip",
  );

  // título voltou ao default -> reassume
  assert.deepEqual(decideAction({ ...base, currentTitle: "Nova sessão", lastSetTitle: "Login Google" }), {
    action: "set",
    title: "Login Google",
    reason: "reset",
  });

  // renomeado manualmente -> respeita
  assert.equal(
    decideAction({ ...base, currentTitle: "Renomeado à mão", lastSetTitle: "Login Google" }).reason,
    "manual",
  );
});

test("decideAction mode always: sobrepõe sempre", () => {
  const res = decideAction({
    config: { mode: "always" },
    agent: "loop-development",
    activePlan: "login-google",
    currentTitle: "Renomeado à mão",
    lastSetTitle: "Login Google",
  });
  assert.deepEqual(res, { action: "set", title: "Login Google", reason: "always" });
});

test("decideAction mode never: só atua quando o título é default", () => {
  const base = { config: { mode: "never" }, agent: "loop-development", activePlan: "login-google" };
  assert.deepEqual(decideAction({ ...base, currentTitle: "Nova sessão" }), {
    action: "set",
    title: "Login Google",
    reason: "default",
  });
  assert.equal(decideAction({ ...base, currentTitle: "Manual" }).reason, "manual");
});

test("estado: round-trip e atualizações", () => {
  const s = emptyState();
  assert.deepEqual(parseState("lixo"), emptyState());

  const updated = updateLastTitle(s, "ses_1", "Login Google", "login-google", 123);
  assert.equal(lastTitleFor(updated, "ses_1"), "Login Google");
  assert.equal(lastTitleFor(updated, "ses_2"), undefined);

  const roundTrip = parseState(serializeState(updated));
  assert.equal(lastTitleFor(roundTrip, "ses_1"), "Login Google");
  assert.equal(roundTrip.titles.ses_1.plan, "login-google");

  const again = updateLastTitle(updated, "ses_1", "Nova Feature", "nova-feature", 456);
  assert.equal(lastTitleFor(again, "ses_1"), "Nova Feature");
  assert.equal(again.titles.ses_2, undefined);
});
