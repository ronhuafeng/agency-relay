// The body-owned classic script runs after preceding stylesheets have settled.
// Keep the large enhancement runtime off the critical stylesheet's connection
// until then, without making it a prerequisite for native parsing or fragments.
declare const CONSOLE_RUNTIME_PATH: string;
const bootstrap = document.currentScript as HTMLScriptElement;
const runtime = document.createElement("script");
runtime.type = "module";
runtime.async = true;
runtime.src = CONSOLE_RUNTIME_PATH;
runtime.nonce = bootstrap.nonce;
document.head.append(runtime);
