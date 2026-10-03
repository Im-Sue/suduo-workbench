# Third-party notices

SuDuo is distributed as source code. The packages below are not included in this repository; pnpm downloads them when you run `pnpm install`. This list shows the runtime (production) dependencies of each workspace and their licenses, generated with `pnpm licenses list --prod`. Each package's full license text is in its own folder under `node_modules` after installation.

Development tools are not listed. Among them is the Codex CLI (`@openai/codex`, Apache-2.0), which `client/` installs as a pinned development dependency and runs on your machine.

The list was generated on macOS (Apple silicon), so a few platform-specific packages (for example `lightningcss-darwin-arm64`) differ on other systems. If you build the Windows installer (`client/scripts/dist-win`), it bundles Node.js, the Codex CLI and the better-sqlite3 native addon; include their licenses when you distribute it.

## client/ (frontend and local backend)

366 packages.

| Package | Version | License |
|---|---|---|
| @dnd-kit/accessibility | 3.1.1 | MIT |
| @dnd-kit/core | 6.3.1 | MIT |
| @dnd-kit/utilities | 3.2.2 | MIT |
| @esbuild/darwin-arm64 | 0.28.1 | MIT |
| @fastify/ajv-compiler | 4.0.6 | MIT |
| @fastify/error | 4.2.0 | MIT |
| @fastify/fast-json-stringify-compiler | 5.1.0 | MIT |
| @fastify/forwarded | 3.0.1 | MIT |
| @fastify/merge-json-schemas | 0.2.1 | MIT |
| @fastify/proxy-addr | 5.1.0 | MIT |
| @floating-ui/core | 1.8.0 | MIT |
| @floating-ui/dom | 1.8.0 | MIT |
| @floating-ui/react-dom | 2.1.9 | MIT |
| @floating-ui/utils | 0.2.12 | MIT |
| @fontsource/ibm-plex-sans | 5.3.0 | OFL-1.1 |
| @fontsource/jetbrains-mono | 5.3.0 | OFL-1.1 |
| @jridgewell/gen-mapping | 0.3.13 | MIT |
| @jridgewell/remapping | 2.3.5 | MIT |
| @jridgewell/resolve-uri | 3.1.2 | MIT |
| @jridgewell/sourcemap-codec | 1.5.5 | MIT |
| @jridgewell/trace-mapping | 0.3.31 | MIT |
| @oxc-project/types | 0.139.0 | MIT |
| @pinojs/redact | 0.4.0 | MIT |
| @radix-ui/number | 1.1.3 | MIT |
| @radix-ui/primitive | 1.1.7 | MIT |
| @radix-ui/react-alert-dialog | 1.1.23 | MIT |
| @radix-ui/react-arrow | 1.1.13, 1.1.15 | MIT |
| @radix-ui/react-avatar | 1.2.6 | MIT |
| @radix-ui/react-checkbox | 1.3.11 | MIT |
| @radix-ui/react-collapsible | 1.1.20 | MIT |
| @radix-ui/react-collection | 1.1.13, 1.1.15 | MIT |
| @radix-ui/react-compose-refs | 1.1.4, 1.1.5 | MIT |
| @radix-ui/react-context | 1.2.1, 1.2.2 | MIT |
| @radix-ui/react-dialog | 1.1.23 | MIT |
| @radix-ui/react-direction | 1.1.3, 1.1.4 | MIT |
| @radix-ui/react-dismissable-layer | 1.1.17, 1.1.19 | MIT |
| @radix-ui/react-dropdown-menu | 2.1.22 | MIT |
| @radix-ui/react-focus-guards | 1.1.5, 1.1.6 | MIT |
| @radix-ui/react-focus-scope | 1.1.14, 1.1.16 | MIT |
| @radix-ui/react-id | 1.1.3, 1.1.4 | MIT |
| @radix-ui/react-label | 2.1.15 | MIT |
| @radix-ui/react-menu | 2.1.22 | MIT |
| @radix-ui/react-popover | 1.1.23 | MIT |
| @radix-ui/react-popper | 1.3.5, 1.3.7 | MIT |
| @radix-ui/react-portal | 1.1.15, 1.1.17 | MIT |
| @radix-ui/react-presence | 1.1.9, 1.1.10 | MIT |
| @radix-ui/react-primitive | 2.1.8, 2.1.10 | MIT |
| @radix-ui/react-radio-group | 1.4.7 | MIT |
| @radix-ui/react-roving-focus | 1.1.17, 1.1.19 | MIT |
| @radix-ui/react-scroll-area | 1.2.18 | MIT |
| @radix-ui/react-select | 2.3.7 | MIT |
| @radix-ui/react-separator | 1.1.15 | MIT |
| @radix-ui/react-slot | 1.3.1, 1.3.3 | MIT |
| @radix-ui/react-switch | 1.3.7 | MIT |
| @radix-ui/react-tabs | 1.1.21 | MIT |
| @radix-ui/react-toggle | 1.1.18 | MIT |
| @radix-ui/react-toggle-group | 1.1.19 | MIT |
| @radix-ui/react-tooltip | 1.2.16 | MIT |
| @radix-ui/react-use-callback-ref | 1.1.3, 1.1.4 | MIT |
| @radix-ui/react-use-controllable-state | 1.2.5, 1.2.6 | MIT |
| @radix-ui/react-use-effect-event | 0.0.4, 0.0.5 | MIT |
| @radix-ui/react-use-is-hydrated | 0.1.2, 0.1.3 | MIT |
| @radix-ui/react-use-layout-effect | 1.1.3, 1.1.4 | MIT |
| @radix-ui/react-use-previous | 1.1.4 | MIT |
| @radix-ui/react-use-rect | 1.1.3, 1.1.4 | MIT |
| @radix-ui/react-use-size | 1.1.3, 1.1.4 | MIT |
| @radix-ui/react-visually-hidden | 1.2.11 | MIT |
| @radix-ui/rect | 1.1.3 | MIT |
| @reduxjs/toolkit | 2.13.0 | MIT |
| @rolldown/binding-darwin-arm64 | 1.1.5 | MIT |
| @rolldown/pluginutils | 1.0.1 | MIT |
| @standard-schema/spec | 1.1.0 | MIT |
| @standard-schema/utils | 0.3.0 | MIT |
| @tailwindcss/node | 4.3.3 | MIT |
| @tailwindcss/oxide | 4.3.3 | MIT |
| @tailwindcss/oxide-darwin-arm64 | 4.3.3 | MIT |
| @tailwindcss/vite | 4.3.3 | MIT |
| @tanstack/history | 1.162.4 | MIT |
| @tanstack/query-core | 5.104.0 | MIT |
| @tanstack/react-query | 5.104.0 | MIT |
| @tanstack/react-router | 1.170.40 | MIT |
| @tanstack/react-store | 0.11.2 | MIT |
| @tanstack/react-virtual | 3.14.13 | MIT |
| @tanstack/router-core | 1.171.33 | MIT |
| @tanstack/store | 0.11.2 | MIT |
| @tanstack/virtual-core | 3.17.11 | MIT |
| @types/d3-array | 3.2.2 | MIT |
| @types/d3-color | 3.1.3 | MIT |
| @types/d3-ease | 3.0.2 | MIT |
| @types/d3-interpolate | 3.0.4 | MIT |
| @types/d3-path | 3.1.1 | MIT |
| @types/d3-scale | 4.0.9 | MIT |
| @types/d3-shape | 3.2.0 | MIT |
| @types/d3-time | 3.0.4 | MIT |
| @types/d3-timer | 3.0.2 | MIT |
| @types/debug | 4.1.13 | MIT |
| @types/estree | 1.0.9 | MIT |
| @types/estree-jsx | 1.0.5 | MIT |
| @types/hast | 3.0.5 | MIT |
| @types/mdast | 4.0.4 | MIT |
| @types/ms | 2.1.0 | MIT |
| @types/node | 26.2.0 | MIT |
| @types/react | 19.2.17 | MIT |
| @types/react-dom | 19.2.3 | MIT |
| @types/trusted-types | 2.0.7 | MIT |
| @types/unist | 2.0.11, 3.0.3 | MIT |
| @types/use-sync-external-store | 0.0.6 | MIT |
| @ungap/structured-clone | 1.3.3 | ISC |
| abstract-logging | 2.0.1 | MIT |
| adler-32 | 1.3.1 | Apache-2.0 |
| ajv | 8.20.0 | MIT |
| ajv-formats | 3.0.1 | MIT |
| aria-hidden | 1.2.6 | MIT |
| atomic-sleep | 1.0.0 | MIT |
| avvio | 9.3.0 | MIT |
| bail | 2.0.2 | MIT |
| base64-js | 1.5.1 | MIT |
| better-sqlite3 | 12.11.1 | MIT |
| bindings | 1.5.0 | MIT |
| bl | 4.1.0 | MIT |
| buffer | 5.7.1 | MIT |
| ccount | 2.0.1 | MIT |
| cfb | 1.2.2 | Apache-2.0 |
| character-entities | 2.0.2 | MIT |
| character-entities-html4 | 2.1.0 | MIT |
| character-entities-legacy | 3.0.0 | MIT |
| character-reference-invalid | 2.0.1 | MIT |
| chownr | 1.1.4 | ISC |
| class-variance-authority | 0.7.1 | Apache-2.0 |
| clsx | 2.1.1 | MIT |
| cmdk | 1.1.1 | MIT |
| codepage | 1.15.0 | Apache-2.0 |
| comma-separated-tokens | 2.0.3 | MIT |
| cookie | 1.1.1 | MIT |
| cookie-es | 3.1.1 | MIT |
| crc-32 | 1.2.2 | Apache-2.0 |
| csstype | 3.2.3 | MIT |
| d3-array | 3.2.4 | ISC |
| d3-color | 3.1.0 | ISC |
| d3-ease | 3.0.1 | BSD-3-Clause |
| d3-format | 3.1.2 | ISC |
| d3-interpolate | 3.0.1 | ISC |
| d3-path | 3.1.0 | ISC |
| d3-scale | 4.0.2 | ISC |
| d3-shape | 3.2.0 | ISC |
| d3-time | 3.1.0 | ISC |
| d3-time-format | 4.1.0 | ISC |
| d3-timer | 3.0.1 | ISC |
| date-fns | 4.4.0 | MIT |
| debug | 4.4.3 | MIT |
| decimal.js-light | 2.5.1 | MIT |
| decode-named-character-reference | 1.3.0 | MIT |
| decompress-response | 6.0.0 | MIT |
| deep-extend | 0.6.0 | MIT |
| dequal | 2.0.3 | MIT |
| detect-libc | 2.1.2 | Apache-2.0 |
| detect-node-es | 1.1.0 | MIT |
| devlop | 1.1.0 | MIT |
| dompurify | 3.2.7, 3.4.12 | (MPL-2.0 OR Apache-2.0) |
| end-of-stream | 1.4.5 | MIT |
| enhanced-resolve | 5.24.3 | MIT |
| es-toolkit | 1.52.0 | MIT |
| esbuild | 0.28.1 | MIT |
| escape-string-regexp | 5.0.0 | MIT |
| estree-util-is-identifier-name | 3.0.0 | MIT |
| eventemitter3 | 5.0.4 | MIT |
| expand-template | 2.0.3 | (MIT OR WTFPL) |
| extend | 3.0.2 | MIT |
| fast-decode-uri-component | 1.0.1 | MIT |
| fast-deep-equal | 3.1.3 | MIT |
| fast-json-stringify | 7.0.1 | MIT |
| fast-querystring | 1.1.2 | MIT |
| fast-uri | 3.1.5, 4.1.2 | BSD-3-Clause |
| fastify | 5.11.3 | MIT |
| fastq | 1.20.1 | ISC |
| fdir | 6.5.0 | MIT |
| fflate | 0.8.2 | MIT |
| file-uri-to-path | 1.0.0 | MIT |
| find-my-way | 9.7.0 | MIT |
| frac | 1.1.2 | Apache-2.0 |
| fs-constants | 1.0.0 | MIT |
| fsevents | 2.3.3 | MIT |
| get-nonce | 1.0.1 | MIT |
| github-from-package | 0.0.0 | MIT |
| graceful-fs | 4.2.11 | ISC |
| hast-util-is-element | 3.0.0 | MIT |
| hast-util-to-jsx-runtime | 2.3.6 | MIT |
| hast-util-to-text | 4.0.2 | MIT |
| hast-util-whitespace | 3.0.0 | MIT |
| highlight.js | 11.11.1 | BSD-3-Clause |
| html-url-attributes | 3.0.1 | MIT |
| ieee754 | 1.2.1 | BSD-3-Clause |
| immer | 11.1.18 | MIT |
| inherits | 2.0.4 | ISC |
| ini | 1.3.8 | ISC |
| inline-style-parser | 0.2.7 | MIT |
| internmap | 2.0.3 | ISC |
| ipaddr.js | 2.4.0 | MIT |
| is-alphabetical | 2.0.1 | MIT |
| is-alphanumerical | 2.0.1 | MIT |
| is-decimal | 2.0.1 | MIT |
| is-hexadecimal | 2.0.1 | MIT |
| is-plain-obj | 4.1.0 | MIT |
| isbot | 5.2.2 | Unlicense |
| jiti | 2.7.0 | MIT |
| json-schema-ref-resolver | 3.0.0 | MIT |
| json-schema-traverse | 1.0.0 | MIT |
| light-my-request | 6.6.0 | BSD-3-Clause |
| lightningcss | 1.32.0 | MPL-2.0 |
| lightningcss-darwin-arm64 | 1.32.0 | MPL-2.0 |
| longest-streak | 3.1.0 | MIT |
| lowlight | 3.3.0 | MIT |
| lucide-react | 1.26.0 | ISC |
| magic-string | 0.30.21 | MIT |
| markdown-table | 3.0.4 | MIT |
| marked | 14.0.0 | MIT |
| mdast-util-find-and-replace | 3.0.2 | MIT |
| mdast-util-from-markdown | 2.0.3 | MIT |
| mdast-util-gfm | 3.1.0 | MIT |
| mdast-util-gfm-autolink-literal | 2.0.1 | MIT |
| mdast-util-gfm-footnote | 2.1.0 | MIT |
| mdast-util-gfm-strikethrough | 2.0.0 | MIT |
| mdast-util-gfm-table | 2.0.0 | MIT |
| mdast-util-gfm-task-list-item | 2.0.0 | MIT |
| mdast-util-mdx-expression | 2.0.1 | MIT |
| mdast-util-mdx-jsx | 3.2.0 | MIT |
| mdast-util-mdxjs-esm | 2.0.1 | MIT |
| mdast-util-phrasing | 4.1.0 | MIT |
| mdast-util-to-hast | 13.2.1 | MIT |
| mdast-util-to-markdown | 2.1.2 | MIT |
| mdast-util-to-string | 4.0.0 | MIT |
| micromark | 4.0.2 | MIT |
| micromark-core-commonmark | 2.0.3 | MIT |
| micromark-extension-gfm | 3.0.0 | MIT |
| micromark-extension-gfm-autolink-literal | 2.1.0 | MIT |
| micromark-extension-gfm-footnote | 2.1.0 | MIT |
| micromark-extension-gfm-strikethrough | 2.1.0 | MIT |
| micromark-extension-gfm-table | 2.1.1 | MIT |
| micromark-extension-gfm-tagfilter | 2.0.0 | MIT |
| micromark-extension-gfm-task-list-item | 2.1.0 | MIT |
| micromark-factory-destination | 2.0.1 | MIT |
| micromark-factory-label | 2.0.1 | MIT |
| micromark-factory-space | 2.0.1 | MIT |
| micromark-factory-title | 2.0.1 | MIT |
| micromark-factory-whitespace | 2.0.1 | MIT |
| micromark-util-character | 2.1.1 | MIT |
| micromark-util-chunked | 2.0.1 | MIT |
| micromark-util-classify-character | 2.0.1 | MIT |
| micromark-util-combine-extensions | 2.0.1 | MIT |
| micromark-util-decode-numeric-character-reference | 2.0.2 | MIT |
| micromark-util-decode-string | 2.0.1 | MIT |
| micromark-util-encode | 2.0.1 | MIT |
| micromark-util-html-tag-name | 2.0.1 | MIT |
| micromark-util-normalize-identifier | 2.0.1 | MIT |
| micromark-util-resolve-all | 2.0.1 | MIT |
| micromark-util-sanitize-uri | 2.0.1 | MIT |
| micromark-util-subtokenize | 2.1.0 | MIT |
| micromark-util-symbol | 2.0.1 | MIT |
| micromark-util-types | 2.0.2 | MIT |
| mimic-response | 3.1.0 | MIT |
| minimist | 1.2.8 | MIT |
| mkdirp-classic | 0.5.3 | MIT |
| monaco-editor | 0.55.1 | MIT |
| ms | 2.1.3 | MIT |
| nanoid | 3.3.15 | MIT |
| napi-build-utils | 2.0.0 | MIT |
| node-abi | 3.94.0 | MIT |
| on-exit-leak-free | 2.1.2 | MIT |
| once | 1.4.0 | ISC |
| parse-entities | 4.0.2 | MIT |
| picocolors | 1.1.1 | ISC |
| picomatch | 4.0.5 | MIT |
| pino | 10.3.1 | MIT |
| pino-abstract-transport | 3.0.0 | MIT |
| pino-std-serializers | 7.1.0 | MIT |
| postcss | 8.5.16 | MIT |
| prebuild-install | 7.1.3 | MIT |
| process-warning | 4.0.1, 5.1.0 | MIT |
| property-information | 7.2.0 | MIT |
| pump | 3.0.4 | MIT |
| quick-format-unescaped | 4.0.4 | MIT |
| rc | 1.2.8 | (BSD-2-Clause OR MIT OR Apache-2.0) |
| react | 19.2.7 | MIT |
| react-dom | 19.2.7 | MIT |
| react-is | 19.3.0 | MIT |
| react-markdown | 10.1.0 | MIT |
| react-redux | 9.3.0 | MIT |
| react-remove-scroll | 2.7.2 | MIT |
| react-remove-scroll-bar | 2.3.8 | MIT |
| react-resizable-panels | 4.14.1 | MIT |
| react-style-singleton | 2.2.3 | MIT |
| readable-stream | 3.6.2 | MIT |
| real-require | 0.2.0, 1.0.0 | MIT |
| recharts | 3.10.1 | MIT |
| redux | 5.0.1 | MIT |
| redux-thunk | 3.1.0 | MIT |
| rehype-highlight | 7.0.2 | MIT |
| remark-gfm | 4.0.1 | MIT |
| remark-parse | 11.0.0 | MIT |
| remark-rehype | 11.1.2 | MIT |
| remark-stringify | 11.0.0 | MIT |
| require-from-string | 2.0.2 | MIT |
| reselect | 5.2.0 | MIT |
| ret | 0.5.0 | MIT |
| reusify | 1.1.0 | MIT |
| rfdc | 1.4.1 | MIT |
| rolldown | 1.1.5 | MIT |
| safe-buffer | 5.2.1 | MIT |
| safe-regex2 | 5.1.1 | MIT |
| safe-stable-stringify | 2.5.0 | MIT |
| scheduler | 0.27.0 | MIT |
| secure-json-parse | 4.1.0 | BSD-3-Clause |
| semver | 7.8.5 | ISC |
| seroval | 1.6.8 | MIT |
| seroval-plugins | 1.6.8 | MIT |
| set-cookie-parser | 2.7.2 | MIT |
| simple-concat | 1.0.1 | MIT |
| simple-get | 4.0.1 | MIT |
| sonic-boom | 4.2.1 | MIT |
| sonner | 2.0.8 | MIT |
| source-map-js | 1.2.1 | BSD-3-Clause |
| space-separated-tokens | 2.0.2 | MIT |
| split2 | 4.2.0 | ISC |
| ssf | 0.11.2 | Apache-2.0 |
| string_decoder | 1.3.0 | MIT |
| stringify-entities | 4.0.4 | MIT |
| strip-json-comments | 2.0.1 | MIT |
| style-to-js | 1.1.21 | MIT |
| style-to-object | 1.0.14 | MIT |
| tailwind-merge | 3.6.0 | MIT |
| tailwindcss | 4.3.3 | MIT |
| tapable | 2.3.3 | MIT |
| tar-fs | 2.1.5 | MIT |
| tar-stream | 2.2.0 | MIT |
| thread-stream | 4.2.0 | MIT |
| tiny-invariant | 1.3.3 | MIT |
| tinyglobby | 0.2.17 | MIT |
| toad-cache | 3.7.4 | MIT |
| trim-lines | 3.0.1 | MIT |
| trough | 2.2.0 | MIT |
| tslib | 2.8.1 | 0BSD |
| tsx | 4.23.0 | MIT |
| tunnel-agent | 0.6.0 | Apache-2.0 |
| tw-animate-css | 1.4.0 | MIT |
| undici-types | 8.3.0 | MIT |
| unified | 11.0.5 | MIT |
| unist-util-find-after | 5.0.0 | MIT |
| unist-util-is | 6.0.1 | MIT |
| unist-util-position | 5.0.0 | MIT |
| unist-util-stringify-position | 4.0.0 | MIT |
| unist-util-visit | 5.1.0 | MIT |
| unist-util-visit-parents | 6.0.2 | MIT |
| use-callback-ref | 1.3.3 | MIT |
| use-sidecar | 1.1.3 | MIT |
| use-sync-external-store | 1.7.0 | MIT |
| util-deprecate | 1.0.2 | MIT |
| vfile | 6.0.3 | MIT |
| vfile-message | 4.0.3 | MIT |
| victory-vendor | 37.3.6 | MIT AND ISC |
| vite | 8.1.4 | MIT |
| wmf | 1.0.2 | Apache-2.0 |
| word | 0.3.0 | Apache-2.0 |
| wrappy | 1.0.2 | ISC |
| xlsx | 0.18.5 | Apache-2.0 |
| yaml | 2.8.1 | ISC |
| zwitch | 2.0.4 | MIT |

## cloud/ (requirements service)

77 packages.

| Package | Version | License |
|---|---|---|
| @fastify/ajv-compiler | 4.0.6 | MIT |
| @fastify/busboy | 3.2.1 | MIT |
| @fastify/error | 4.2.0 | MIT |
| @fastify/fast-json-stringify-compiler | 5.1.0 | MIT |
| @fastify/forwarded | 3.0.1 | MIT |
| @fastify/jwt | 10.2.1 | MIT |
| @fastify/merge-json-schemas | 0.2.1 | MIT |
| @fastify/proxy-addr | 5.1.0 | MIT |
| @lukeed/ms | 2.0.2 | MIT |
| @pinojs/redact | 0.4.0 | MIT |
| abstract-logging | 2.0.1 | MIT |
| ajv | 8.20.0 | MIT |
| ajv-formats | 3.0.1 | MIT |
| asn1.js | 5.4.1 | MIT |
| atomic-sleep | 1.0.0 | MIT |
| avvio | 9.3.0 | MIT |
| bn.js | 4.12.5 | MIT |
| cookie | 1.1.1 | MIT |
| dequal | 2.0.3 | MIT |
| ecdsa-sig-formatter | 1.0.11 | Apache-2.0 |
| fast-decode-uri-component | 1.0.1 | MIT |
| fast-deep-equal | 3.1.3 | MIT |
| fast-json-stringify | 7.0.1 | MIT |
| fast-jwt | 6.3.2 | Apache-2.0 |
| fast-querystring | 1.1.2 | MIT |
| fast-uri | 3.1.5, 4.1.2 | BSD-3-Clause |
| fastfall | 1.5.1 | MIT |
| fastify | 5.11.3 | MIT |
| fastify-plugin | 6.0.0 | MIT |
| fastparallel | 2.4.1 | ISC |
| fastq | 1.20.1 | ISC |
| fastseries | 1.7.2 | ISC |
| find-my-way | 9.7.0 | MIT |
| inherits | 2.0.4 | ISC |
| ipaddr.js | 2.4.0 | MIT |
| json-schema-ref-resolver | 3.0.0 | MIT |
| json-schema-traverse | 1.0.0 | MIT |
| light-my-request | 6.6.0 | BSD-3-Clause |
| minimalistic-assert | 1.0.1 | ISC |
| mnemonist | 0.40.4 | MIT |
| obliterator | 2.0.5 | MIT |
| on-exit-leak-free | 2.1.2 | MIT |
| pg | 8.23.0 | MIT |
| pg-cloudflare | 1.4.0 | MIT |
| pg-connection-string | 2.14.0 | MIT |
| pg-int8 | 1.0.1 | ISC |
| pg-pool | 3.14.0 | MIT |
| pg-protocol | 1.16.0 | MIT |
| pg-types | 2.2.0 | MIT |
| pgpass | 1.0.5 | MIT |
| pino | 10.3.1 | MIT |
| pino-abstract-transport | 3.0.0 | MIT |
| pino-std-serializers | 7.1.0 | MIT |
| postgres-array | 2.0.0 | MIT |
| postgres-bytea | 1.0.1 | MIT |
| postgres-date | 1.0.7 | MIT |
| postgres-interval | 1.2.0 | MIT |
| process-warning | 4.0.1, 5.1.0 | MIT |
| quick-format-unescaped | 4.0.4 | MIT |
| real-require | 0.2.0, 1.0.0 | MIT |
| require-from-string | 2.0.2 | MIT |
| ret | 0.5.0 | MIT |
| reusify | 1.1.0 | MIT |
| rfdc | 1.4.1 | MIT |
| safe-buffer | 5.2.1 | MIT |
| safe-regex2 | 5.1.1 | MIT |
| safe-stable-stringify | 2.5.0 | MIT |
| safer-buffer | 2.1.2 | MIT |
| secure-json-parse | 4.1.0 | BSD-3-Clause |
| semver | 7.8.5 | ISC |
| set-cookie-parser | 2.7.2 | MIT |
| sonic-boom | 4.2.1 | MIT |
| split2 | 4.2.0 | ISC |
| steed | 1.1.3 | MIT |
| thread-stream | 4.2.0 | MIT |
| toad-cache | 3.7.4 | MIT |
| xtend | 4.0.2 | MIT |
