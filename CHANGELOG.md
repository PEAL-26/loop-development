# [1.0.0](https://github.com/PEAL-26/loop-development/compare/v0.7.0...v1.0.0) (2026-10-09)


* feat!: migração para OpenCode V2 — plugins, config, agentes e doctor ([6777f47](https://github.com/PEAL-26/loop-development/commit/6777f476cf163f3eeebadc70ad66583ce3db87a5))


### BREAKING CHANGES

* requer OpenCode >= v2.0. O formato do config mudou de V1
(mapas permission/agent) para V2 (array permissions ordenado). Os plugins
passam a usar default export { id, setup }. Acções renomeadas: bash->shell,
task->subagent, write/patch->edit. O script prepare foi removido do
package.json (o CI usa npm ci que já instala as dependências).

- Plugins session-title e telegram portados para V2 (default export, ctx.storage,
  ctx.permission.reply com campo decision, eventos permission.asked e form.created)
- opencode/opencode.json convertido para permissions array com 36 guardas de shell
- 21 agentes migrados: permissions array, temperature em request.body, subagent rules
- src/doctor.js: comando loop-development doctor com 6 verificações e --fix
- src/deps.js + tsconfig.json: typecheck dos plugins em CI
- src/merge-config.js: merge aditivo por identidade de regra, migrateV1ToV2
- src/install.js: installer version-aware por hash (staleness vs edição local)
- src/plan.js: migrateProject aceita date para resultados determinísticos
- testes: 258/258 pass, typecheck 0 erros

Migração de instalações existentes: loop-development update --force

# [0.7.0](https://github.com/PEAL-26/loop-development/compare/v0.6.0...v0.7.0) (2026-10-09)


### Bug Fixes

* remove registry-url e adicionar NODE_AUTH_TOKEN para fix do NPM publish no semantic-release ([2245eaa](https://github.com/PEAL-26/loop-development/commit/2245eaa10b7e9c28c31f6bc0514ac3353d44e823))


### Features

* implement doctor command for OpenCode V2 migration checks ([ae478b3](https://github.com/PEAL-26/loop-development/commit/ae478b34e4c3a93869e865558cd92120061d2643))
* modos de execucao simple e complete (/loop-development-simples + set-mode) ([a804468](https://github.com/PEAL-26/loop-development/commit/a804468e5356221bdf5ce4ae2c8c414f2a4ee4f1))
* segredos check/purge (M004), verificacao por tarefa vs final (M005) e sumarios sem redundancia (M006) ([687a8ad](https://github.com/PEAL-26/loop-development/commit/687a8ad18caf7a0d8e8abf02e3d86bdff6c18440))
