import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

export const PACKAGE_MANAGERS = [
  { id: "npm", label: "npm", run: "npm run" },
  { id: "pnpm", label: "pnpm", run: "pnpm" },
  { id: "yarn", label: "yarn", run: "yarn" },
  { id: "bun", label: "bun", run: "bun run" }
];

export const BACKEND_PRESETS = [
  {
    id: "nestjs-prisma",
    label: "NestJS + Prisma",
    stack: "NestJS 11 (Express) + Prisma 7 + PostgreSQL (ou SQLite/MySQL via datasource). TypeScript, Node >= 20. Gestor de pacotes: {pm}.",
    conventions: [
      "Estrutura por feature modules: src/modules/<feature>/ com .module.ts, .controller.ts, .service.ts e dto/*.dto.ts; código partilhado em src/common/; config em src/config/.",
      "Naming: ficheiros em kebab-case com sufixo de papel (.module, .controller, .service, .dto); classes em PascalCase; DTOs terminam em Dto.",
      "Validar tudo na fronteira com DTOs + ValidationPipe global ({ whitelist: true, transform: true, forbidNonWhitelisted: true }); nunca confiar no body.",
      "Prisma: schema em prisma/schema.prisma; modelos/tabelas em inglês e colunas em snake_case; migrações versionadas; correr npx prisma generate após alterar o schema (no v7 é explícito).",
      "Testes: .spec.ts junto da classe (Jest + @nestjs/testing); .e2e-spec.ts em test/ com Supertest request(app.getHttpServer()); replicar pipes/guards globais do main.ts nos e2e.",
      "Env via @nestjs/config (ConfigModule.forRoot({ isGlobal: true })) com schema de validação (Joi/zod); DATABASE_URL no .env.",
      "Commits em Conventional Commits; ESLint flat config + Prettier.",
      "Erros: exceções de domínio mapeadas para HTTP por filtros de exceção; nunca expor stack traces nem detalhes internos."
    ],
    commands: [
      { label: "Dev", command: "{run} start:dev" },
      { label: "Testes", command: "{run} test" },
      { label: "Testes e2e", command: "{run} test:e2e" },
      { label: "Typecheck", command: "npx tsc --noEmit" },
      { label: "Lint", command: "{run} lint" },
      { label: "Formatação", command: "{run} format" },
      { label: "Build", command: "{run} build" },
      { label: "Produção", command: "{run} start:prod" },
      { label: "Migração Prisma", command: "npx prisma migrate dev --name <nome>" },
      { label: "Prisma generate", command: "npx prisma generate" }
    ],
    structure: [
      "src/",
      "  main.ts             # bootstrap, ValidationPipe global, helmet, CORS",
      "  app.module.ts       # raiz: ConfigModule + módulos de features",
      "  modules/<feature>/  # .module.ts, .controller.ts, .service.ts, dto/",
      "  common/             # guards, pipes, interceptors, filtros de exceção",
      "  config/             # schema de env",
      "prisma/",
      "  schema.prisma",
      "  migrations/         # versionadas — não editar as aplicadas",
      "test/",
      "  app.e2e-spec.ts",
      "  jest-e2e.json"
    ],
    never: [
      "Nunca editar/apagar migrações já aplicadas em produção; usar prisma migrate deploy em prod e nunca prisma db push.",
      "Nunca commitar DATABASE_URL nem chaves; nunca logar queries com dados sensíveis.",
      "Nunca pôr lógica de negócio no controller; nunca usar any em DTOs/serviços.",
      "Nunca desligar o ValidationPipe nem remover whitelist/forbidNonWhitelisted.",
      "Nunca registar helmet/CORS depois das rotas — a ordem importa."
    ]
  },
  {
    id: "nestjs-supabase",
    label: "NestJS + Supabase",
    stack: "NestJS 11 (Express) + Supabase (Postgres + Auth + Storage + RLS). TypeScript, Node >= 20. Gestor de pacotes: {pm}.",
    conventions: [
      "Estrutura por feature modules: src/modules/<feature>/ com .module.ts, .controller.ts, .service.ts e dto/*.dto.ts; código partilhado em src/common/; config em src/config/.",
      "Naming: ficheiros em kebab-case com sufixo de papel (.module, .controller, .service, .dto); classes em PascalCase; DTOs terminam em Dto.",
      "Validar tudo na fronteira com DTOs + ValidationPipe global ({ whitelist: true, transform: true, forbidNonWhitelisted: true }); nunca confiar no body.",
      "Dois clientes Supabase: um com publishable key (respeita RLS, operações do utilizador) e outro com secret key (bypassa RLS, só no servidor/administração).",
      "Auth no servidor: validar o JWT com supabase.auth.getUser()/getClaims(); nunca confiar em user_id vindo do cliente.",
      "RLS é a barreira de segurança nº 1: manter sempre ativo; policies com TO anon|authenticated|service_role + USING/WITH CHECK.",
      "Migrações via Supabase CLI (supabase start local + migrations/*.sql versionadas).",
      "Testes: .spec.ts junto da classe (Jest); .e2e-spec.ts em test/ com Supertest; mockar o cliente supabase nos unit.",
      "Env via @nestjs/config com schema de validação; URLs e chaves Supabase no .env."
    ],
    commands: [
      { label: "Dev", command: "{run} start:dev" },
      { label: "Testes", command: "{run} test" },
      { label: "Testes e2e", command: "{run} test:e2e" },
      { label: "Typecheck", command: "npx tsc --noEmit" },
      { label: "Lint", command: "{run} lint" },
      { label: "Formatação", command: "{run} format" },
      { label: "Build", command: "{run} build" },
      { label: "Produção", command: "{run} start:prod" },
      { label: "Supabase local", command: "npx supabase start" },
      { label: "Reset da base local", command: "npx supabase db reset" },
      { label: "Diff de migração", command: "npx supabase db diff" }
    ],
    structure: [
      "src/",
      "  main.ts             # bootstrap, ValidationPipe global, helmet, CORS",
      "  app.module.ts       # raiz: ConfigModule + módulos de features",
      "  modules/<feature>/  # .module.ts, .controller.ts, .service.ts, dto/",
      "  supabase/           # clientes publishable/secret",
      "  common/",
      "  config/",
      "supabase/",
      "  migrations/         # *.sql versionadas",
      "  seed.sql",
      "test/"
    ],
    never: [
      "Nunca desativar RLS em tabelas de schemas expostos.",
      "Nunca expor a secret key ao cliente — só a publishable key.",
      "Nunca usar views que fazem bypass de RLS sem security_invoker = on.",
      "Nunca confiar no user da sessão sem validar o token (getUser/getClaims).",
      "Nunca commitar chaves/URLs do Supabase."
    ]
  },
  {
    id: "express",
    label: "Node.js + Express",
    stack: "Node.js >= 22 + Express 5 + TypeScript. Gestor de pacotes: {pm}.",
    conventions: [
      "Handlers async não precisam de try/catch nem wrapper no Express 5: rejected promises são encaminhadas automaticamente como next(err) — sem asyncHandler/catchAsync.",
      "Error handler com 4 argumentos (err, req, res, next), registado por último; delegar com next(err) se res.headersSent.",
      "Ordem: helmet(), cors(), express.json({ limit }), rotas, error handler no fim.",
      "Estrutura: src/app.ts (setup) + src/server.ts (startup); routes/, controllers/ finos, services/, middleware/, config/, validators/ (zod).",
      "Validar input com zod nos validators e validar env no arranque (fail-fast).",
      "Testes: app factory pattern (createApp separado do listen) + Vitest + Supertest, sem porta real.",
      "Commits em Conventional Commits; ESLint flat config + Prettier."
    ],
    commands: [
      { label: "Dev", command: "{run} dev" },
      { label: "Testes", command: "{run} test" },
      { label: "Typecheck", command: "npx tsc --noEmit" },
      { label: "Lint", command: "{run} lint" },
      { label: "Formatação", command: "{run} format" },
      { label: "Build", command: "{run} build" },
      { label: "Start", command: "{run} start" }
    ],
    structure: [
      "src/",
      "  app.ts        # createApp: helmet, cors, json, rotas, error handler",
      "  server.ts     # listen (porta/endereço do env)",
      "  routes/",
      "  controllers/  # finos",
      "  services/",
      "  middleware/",
      "  validators/   # zod",
      "  config/       # schema de env",
      "test/"
    ],
    never: [
      "Nunca usar error handler com 3 argumentos (vira handler normal e o erro fica sem tratamento).",
      "Nunca definir o error handler antes das rotas.",
      "Nunca esquecer next(err)/.catch(next) em APIs callback-based (ex.: node:fs).",
      "Nunca devolver stack traces nem detalhes internos no response."
    ]
  },
  {
    id: "fastify",
    label: "Fastify",
    stack: "Fastify 5 + TypeScript (scaffold fastify-cli). Gestor de pacotes: {pm}.",
    conventions: [
      "Validação via @fastify/type-provider-zod (requer Zod >= 4.2) com withTypeProvider<ZodTypeProvider>() e setValidatorCompiler/setSerializerCompiler; serialização derivada de z.output.",
      "Plugins registados com app.register() (ex.: @fastify/helmet), nunca app.use.",
      "Testes sem servidor externo: app.inject() (light-my-request).",
      "Estrutura do CLI: app.ts (build da instância) + plugins/ + routes/ + test/.",
      "Registar plugins e rotas antes de listen()/ready().",
      "Commits em Conventional Commits; ESLint flat config + Prettier."
    ],
    commands: [
      { label: "Dev", command: "{run} dev" },
      { label: "Testes", command: "{run} test" },
      { label: "Typecheck", command: "npx tsc --noEmit" },
      { label: "Lint", command: "{run} lint" },
      { label: "Formatação", command: "{run} format" },
      { label: "Build", command: "{run} build" },
      { label: "Start", command: "{run} start" }
    ],
    structure: [
      "app.ts       # instância Fastify (build)",
      "plugins/     # @fastify/helmet, etc.",
      "routes/",
      "test/        # app.inject()"
    ],
    never: [
      "Nunca misturar validators sem type provider (perdes tipagem no handler).",
      "Nunca registar plugins/rotas depois de listen()/ready().",
      "Nunca assumir Zod v3 com o type-provider-zod (exige Zod >= 4.2)."
    ]
  }
];

export const FRONTEND_PRESETS = [
  {
    id: "expo",
    label: "Expo (React Native)",
    stack: "Expo SDK 55 (React Native) + Expo Router + TypeScript strict. Gestor de pacotes: {pm}.",
    conventions: [
      "Rotas por ficheiros em src/app/ (cada ficheiro = rota), _layout.tsx raiz, route groups (tabs); typed routes geradas em .expo/types.",
      "Env: prefixo EXPO_PUBLIC_ obrigatório e só com notação estática (process.env.EXPO_PUBLIC_X); segredos nunca em EXPO_PUBLIC_*.",
      "Instalar libs nativas com npx expo install (garante compatibilidade com o SDK), nunca npm direto.",
      "Safe areas com react-native-safe-area-context (SafeAreaView/useSafeAreaInsets).",
      "ESLint flat config: npx expo lint cria eslint.config.js estendendo eslint-config-expo.",
      "tsconfig estende expo/tsconfig.base com strict: true e alias @/* -> ./src/*.",
      "Testes com preset jest-expo.",
      "EAS: profiles em eas.json (build/submit/update)."
    ],
    commands: [
      { label: "Dev", command: "npx expo start" },
      { label: "Testes", command: "{run} test" },
      { label: "Typecheck", command: "npx tsc --noEmit" },
      { label: "Lint", command: "npx expo lint" },
      { label: "Formatação", command: "npx prettier --write ." },
      { label: "Build", command: "npx expo export" },
      { label: "EAS build", command: "npx eas build -p <android|ios|all>" },
      { label: "EAS submit", command: "npx eas submit" }
    ],
    structure: [
      "src/app/        # rotas (expo-router) + _layout.tsx",
      "src/components/",
      "src/constants/",
      "assets/",
      "app.json",
      "eas.json"
    ],
    never: [
      "Nunca pôr segredos em EXPO_PUBLIC_* (ficam em texto plano no bundle).",
      "Nunca usar notação não-estática para env vars (não é inlined no bundle).",
      "Nunca instalar libs RN com npm direto sem npx expo install.",
      "Nunca esquecer \"main\": \"expo-router/entry\" no package.json."
    ]
  },
  {
    id: "next",
    label: "Next.js",
    stack: "Next.js 16 (App Router) + React 19 + TypeScript + Tailwind. Gestor de pacotes: {pm}.",
    conventions: [
      "Layouts e pages são Server Components por default; 'use client' só quando necessário (marca o boundary no topo do ficheiro).",
      "metadata/generateMetadata só em Server Components; exportar um ou outro, nunca ambos.",
      "No Next 16, middleware.ts está deprecado — usar proxy.ts com export proxy.",
      "Com cacheComponents ativo, não usar dynamic/revalidate/fetchCache; usar use cache + cacheLife/cacheTag.",
      "Env: .env.local etc. não versionados; NEXT_PUBLIC_* só para expor ao cliente.",
      "Lint: ESLint CLI com eslint.config.mjs (eslint-config-next/core-web-vitals).",
      "Testes: Vitest + Testing Library; async Server Components com fetch são cobertos por E2E (Vitest não os suporta)."
    ],
    commands: [
      { label: "Dev", command: "{run} dev" },
      { label: "Testes", command: "{run} test" },
      { label: "Typecheck", command: "npx tsc --noEmit" },
      { label: "Lint", command: "{run} lint" },
      { label: "Formatação", command: "npx prettier --write ." },
      { label: "Build", command: "{run} build" },
      { label: "Start", command: "{run} start" }
    ],
    structure: [
      "app/             # rotas App Router: layouts, pages, route handlers",
      "components/      # UI e componentes reutilizáveis",
      "lib/             # utils, api, auth",
      "public/",
      "next.config.ts",
      "eslint.config.mjs"
    ],
    never: [
      "Nunca usar middleware.ts em projeto novo — usar proxy.ts.",
      "Nunca exportar dynamic/revalidate/fetchCache com cacheComponents ativo.",
      "Nunca ler cookies()/headers()/auth() dentro de função use cache (resolver no caller).",
      "Nunca pôr segredos em NEXT_PUBLIC_*.",
      "Nunca desativar typescript.ignoreBuildErrors/eslint.ignoreDuringBuilds para 'desenrascar'."
    ]
  },
  {
    id: "vite",
    label: "React + Vite",
    stack: "React + Vite + TypeScript (create-vite react-ts). Gestor de pacotes: {pm}.",
    conventions: [
      "ESLint flat config (eslint.config.js): js.recommended + tseslint.recommended + reactHooks + reactRefresh; usar recommendedTypeChecked para rigor.",
      "Env: só variáveis VITE_* são expostas ao cliente via import.meta.env; tipá-las em src/vite-env.d.ts (interface ImportMetaEnv).",
      "Ficheiros .env/.env.local gitignored; .env.[mode] tem precedência por modo; vite build usa o modo production.",
      "Testes com Vitest (reusa o vite.config).",
      "Estrutura do template: index.html na raiz, src/main.tsx, src/App.tsx, src/vite-env.d.ts, tsconfig.app.json + tsconfig.node.json.",
      "Commits em Conventional Commits; Prettier para formatação."
    ],
    commands: [
      { label: "Dev", command: "{run} dev" },
      { label: "Testes", command: "{run} test" },
      { label: "Typecheck", command: "npx tsc --noEmit" },
      { label: "Lint", command: "{run} lint" },
      { label: "Formatação", command: "npx prettier --write ." },
      { label: "Build", command: "{run} build" },
      { label: "Preview", command: "{run} preview" }
    ],
    structure: [
      "index.html",
      "src/",
      "  main.tsx",
      "  App.tsx",
      "  vite-env.d.ts",
      "  components/",
      "  hooks/",
      "tsconfig.app.json",
      "tsconfig.node.json",
      "vite.config.ts",
      "eslint.config.js"
    ],
    never: [
      "Nunca pôr segredos em VITE_* (ficam embutidos no bundle cliente).",
      "Nunca mudar o envPrefix sem perceber a exposição.",
      "Nunca correr testes em modo watch no CI (usar vitest run)."
    ]
  }
];

export function findPreset(type, id) {
  if (!id) return null;
  const list = type === "frontend" ? FRONTEND_PRESETS : BACKEND_PRESETS;
  return list.find((p) => p.id === id) ?? null;
}

export function resolvePm(id) {
  return PACKAGE_MANAGERS.find((p) => p.id === id) ?? PACKAGE_MANAGERS[0];
}

export function isValidPm(id) {
  return id == null || PACKAGE_MANAGERS.some((p) => p.id === id);
}

export async function detectPackageManager(targetDir = process.cwd()) {
  const lockfiles = [
    ["pnpm-lock.yaml", "pnpm"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"]
  ];
  for (const [name, id] of lockfiles) {
    if (existsSync(join(targetDir, name))) return id;
  }
  try {
    const pkg = JSON.parse(await readFile(join(targetDir, "package.json"), "utf8"));
    if (typeof pkg.packageManager === "string") {
      const id = pkg.packageManager.split("@")[0];
      if (PACKAGE_MANAGERS.some((p) => p.id === id)) return id;
    }
  } catch {
    /* sem package.json */
  }
  return null;
}

export function buildAgentsMd({ backend = null, frontend = null, pm = null } = {}) {
  const b = backend ? findPreset("backend", backend) : null;
  const f = frontend ? findPreset("frontend", frontend) : null;
  if (backend && !b) throw new Error(`Preset de backend desconhecido: ${backend}`);
  if (frontend && !f) throw new Error(`Preset de frontend desconhecido: ${frontend}`);
  if (!b && !f) throw new Error("buildAgentsMd requer pelo menos um preset (backend ou frontend)");
  if (!isValidPm(pm)) throw new Error(`Gestor de pacotes desconhecido: ${pm}`);

  const pmObj = resolvePm(pm);
  const lines = [];

  lines.push("# AGENTS.md", "");
  lines.push("Regras da casa carregadas automaticamente pelo OpenCode em todas as sessões deste projeto. O Context Loader e todos os subagents do Loop Development devem respeitar estas secções.", "");

  lines.push("## Stack", "");
  if (b) lines.push(`- ${b.stack.replaceAll("{pm}", pmObj.label)}`);
  if (f) lines.push(`- ${f.stack.replaceAll("{pm}", pmObj.label)}`);
  lines.push("");

  lines.push("## Convenções", "");
  for (const c of b?.conventions ?? []) lines.push(`- ${c}`);
  for (const c of f?.conventions ?? []) lines.push(`- ${c}`);
  lines.push("");

  lines.push("## Comandos do projeto", "");
  const all = [
    ...(b?.commands ?? []).map((c) => ({ ...c, tag: "backend" })),
    ...(f?.commands ?? []).map((c) => ({ ...c, tag: "frontend" }))
  ];
  const grouped = new Map();
  for (const c of all) {
    if (!grouped.has(c.label)) grouped.set(c.label, []);
    grouped.get(c.label).push(c);
  }
  for (const [label, entries] of grouped) {
    const distinct = new Set(entries.map((e) => e.command));
    if (entries.length === 1 || distinct.size === 1) {
      lines.push(`- ${label}: ${entries[0].command.replaceAll("{run}", pmObj.run)}`);
    } else {
      for (const e of entries) {
        lines.push(`- ${label} (${e.tag}): ${e.command.replaceAll("{run}", pmObj.run)}`);
      }
    }
  }
  lines.push("");

  lines.push("## Estrutura de pastas relevante", "", "```");
  for (const line of b?.structure ?? []) lines.push(line);
  if (b && f) lines.push("");
  for (const line of f?.structure ?? []) lines.push(line);
  lines.push("```", "");

  lines.push("## O que nunca fazer", "");
  for (const n of b?.never ?? []) lines.push(`- ${n}`);
  for (const n of f?.never ?? []) lines.push(`- ${n}`);
  lines.push("");

  return lines.join("\n");
}
