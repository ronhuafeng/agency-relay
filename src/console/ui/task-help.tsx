import { buildClientSetupFiles, CLIENT_SETUP_TOKEN_PLACEHOLDER, PRODUCT_ACCESS } from "../client-setup";
import { SetupFilesIsland } from "./islands";
import { ConfigurationInstructions, type ConfigurationHelpProps } from "./configuration-instructions";
import type { SetupFileTarget } from "./setup-files";

/** Public previews always use the placeholder, never newly issued or user input keys. */
export function configurationTargets(scopes: readonly string[]): SetupFileTarget[] {
  return buildClientSetupFiles({token:CLIENT_SETUP_TOKEN_PLACEHOLDER,scopes}).map(({client,clientLabel,filename,installTarget,content})=>({
    client,clientLabel,filename,installTarget,template:content.split("\n").filter(line=>!line.startsWith("#")).join("\n").trim()
  }));
}

/** Contextual help consumes the same templates as downloads; no second setup format. */
export function ConfigurationHelp({recoveryHref}: ConfigurationHelpProps) {
  const examples = configurationTargets(Object.values(PRODUCT_ACCESS).map(item => item.grant));
  return <section data-task-help="configuration" className="configuration-targets"><SetupFilesIsland control={{id:"local-config-files",files:examples,clientSelectId:"select-sync-client"}}/><ConfigurationInstructions recoveryHref={recoveryHref}/></section>;
}
export { ConfigurationInstructions, type ConfigurationHelpProps };
