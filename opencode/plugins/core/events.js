// Helpers para ler o stream de eventos do OpenCode V2, partilhados pelos
// plugins. São puros (sem I/O) para poderem ser testados directamente.
//
// O V2 publica eventos em duas gerações em paralelo e com envelopes diferentes:
//
//   geração nova   → { type, data: {...}, location: { directory, ... } }
//   geração legada → { type, properties: {...}, directory }
//
// `permission.v2.asked` e `question.v2.*` são novos; `permission.asked`,
// `question.asked` e `session.idle` são legados. Estes helpers escondem a
// diferença para que o resto do código veja uma só forma.

export function eventPayload(event) {
  if (event == null || typeof event !== "object") return null;
  return event.data ?? event.properties ?? null;
}

export function eventSessionID(event) {
  const payload = eventPayload(event);
  return payload?.sessionID ?? "";
}

export function eventRequestID(event) {
  const payload = eventPayload(event);
  return payload?.id ?? payload?.requestID ?? "";
}

// O stream é global (partilhado entre localizações). Devolve o directório do
// evento, ou null quando o evento não está associado a nenhuma — nesse caso o
// chamador decide se o trata como global ou o ignora.
export function eventDirectory(event) {
  if (event == null || typeof event !== "object") return null;
  return event.location?.directory ?? event.directory ?? null;
}

// true quando o evento pertence à localização indicada. Eventos sem
// directório são tratados como globais e portanto não pertencem a ninguém em
// particular — o filtro do plugin descarta-os.
export function isLocalEvent(event, directory) {
  return eventDirectory(event) === directory;
}