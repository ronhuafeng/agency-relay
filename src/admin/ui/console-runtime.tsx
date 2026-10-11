import { consoleBootstrapSource } from "../generated/console-bootstrap";

export function ConsoleRuntime({ nonce }: { nonce?: string }) {
  return <script nonce={nonce} data-console-bootstrap="" dangerouslySetInnerHTML={{ __html: consoleBootstrapSource }} />;
}
