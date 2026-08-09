import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shortId,
  baseName,
  formatAlwaysPatterns,
  isAuthorized,
  permissionText,
  permissionKeyboard,
  permissionAlwaysConfirmText,
  permissionAlwaysConfirmKeyboard,
  permissionResultText,
  questionText,
  questionKeyboard,
  parseCallbackData,
  permissionCallback,
  permissionAlwaysConfirmCallback,
  questionOptionCallback,
  questionDoneCallback,
} from "../opencode/plugins/core/telegram-core.js";

test("shortId e baseName", () => {
  assert.equal(shortId("per_abc12345"), "per_abc1");
  assert.equal(shortId(undefined), "");
  assert.equal(baseName("D:\\dev\\proj"), "proj");
  assert.equal(baseName("/home/user/dev/proj"), "proj");
  assert.equal(baseName(""), "projeto");
});

test("formatAlwaysPatterns", () => {
  assert.equal(formatAlwaysPatterns(["bash", "edit"]), "bash, edit");
  assert.equal(formatAlwaysPatterns([]), "(padrões não propostos)");
  assert.equal(formatAlwaysPatterns(null), "(padrões não propostos)");
});

test("isAuthorized", () => {
  assert.equal(isAuthorized(123, [123, 456]), true);
  assert.equal(isAuthorized(789, [123, 456]), false);
  assert.equal(isAuthorized(123, null), false);
});

test("permissionText inclui projeto, ferramenta, recurso e sessão", () => {
  const text = permissionText(
    { permission: "bash", patterns: ["git push"], sessionID: "ses_abcdefgh" },
    "proj",
  );
  assert.match(text, /proj/);
  assert.match(text, /bash/);
  assert.match(text, /git push/);
  assert.match(text, /ses_abcd/);
});

test("permissionKeyboard gera 3 botões e round-trip do callback", () => {
  const kb = permissionKeyboard("per_abc");
  assert.equal(kb.inline_keyboard.length, 3);
  const data = kb.inline_keyboard[0][0].callback_data;
  assert.deepEqual(parseCallbackData(data), { kind: "permission", action: "once", requestID: "per_abc" });
  assert.deepEqual(parseCallbackData(permissionCallback("always", "per_abc")), {
    kind: "permission",
    action: "always",
    requestID: "per_abc",
  });
  assert.deepEqual(parseCallbackData(permissionCallback("reject", "per_abc")), {
    kind: "permission",
    action: "reject",
    requestID: "per_abc",
  });
});

test("fluxo 'sempre' mostra confirmação com padrões", () => {
  const text = permissionAlwaysConfirmText(
    { permission: "edit", patterns: ["src/**"], always: ["src/**"], sessionID: "ses_1" },
    "proj",
  );
  assert.match(text, /SEMPRE/);
  assert.match(text, /src\/\*\*/);
  const kb = permissionAlwaysConfirmKeyboard("per_abc");
  assert.deepEqual(parseCallbackData(kb.inline_keyboard[0][0].callback_data), {
    kind: "permission-confirm",
    confirmed: true,
    requestID: "per_abc",
  });
  assert.deepEqual(parseCallbackData(kb.inline_keyboard[0][1].callback_data), {
    kind: "permission-confirm",
    confirmed: false,
    requestID: "per_abc",
  });
});

test("permissionResultText", () => {
  assert.equal(permissionResultText("once"), "✅ Aprovado (uma vez)");
  assert.equal(permissionResultText("always"), "🔁 Aprovado para sempre");
  assert.equal(permissionResultText("reject"), "❌ Rejeitado");
});

test("questionText mostra pergunta, header e contagem", () => {
  const text = questionText(
    { header: "Aprovar?", question: "Aprovas o plano?", options: [], multiple: false },
    "proj",
    1,
    2,
  );
  assert.match(text, /Aprovar\?/);
  assert.match(text, /2\/2/);
  assert.match(text, /proj/);
});

test("questionKeyboard gera opções e round-trip do callback", () => {
  const kb = questionKeyboard("que_1", 0, { options: [{ label: "Aprovar" }, { label: "Alterar" }] }, []);
  assert.equal(kb.inline_keyboard.length, 2);
  const data = kb.inline_keyboard[0][0].callback_data;
  assert.deepEqual(parseCallbackData(data), {
    kind: "question-option",
    mode: "once",
    requestID: "que_1",
    qIndex: 0,
    optionIndex: 0,
  });
});

test("questionKeyboard multi tem marcação e botão de concluir", () => {
  const kb = questionKeyboard(
    "que_1",
    0,
    { multiple: true, options: [{ label: "A" }, { label: "B" }] },
    [1],
  );
  assert.match(kb.inline_keyboard[0][0].text, /⬜️/);
  assert.match(kb.inline_keyboard[1][0].text, /☑️/);
  const done = kb.inline_keyboard[2][0].callback_data;
  assert.deepEqual(parseCallbackData(done), { kind: "question-done", requestID: "que_1", qIndex: 0 });
});

test("questionKeyboard sem opções devolve null", () => {
  assert.equal(questionKeyboard("que_1", 0, { options: [] }), null);
});

test("parseCallbackData desconhecido devolve null", () => {
  assert.equal(parseCallbackData("zz:1:2"), null);
  assert.equal(parseCallbackData(""), null);
});
