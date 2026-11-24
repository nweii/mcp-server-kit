import { eslintCompatPlugin } from "@oxlint/plugins";

import { noModuleMockingRule } from "./rules/no-module-mocking.ts";
import { noForbiddenTermInSymbolNamesRule } from "./rules/no-shape-in-symbol-names.ts";
import { requireSafetyCommentForTypeAssertionRule } from "./rules/require-safety-comment-for-type-assertion.ts";

/** Anti-slop rules that the Cloudflare Oxlint preset does not already cover. */
const antiSlopPlugin = eslintCompatPlugin({
  meta: { name: "anti-slop" },
  rules: {
    "no-module-mocking": noModuleMockingRule,
    "no-shape-in-symbol-names": noForbiddenTermInSymbolNamesRule,
    "require-safety-comment-for-type-assertion": requireSafetyCommentForTypeAssertionRule,
  },
});

export default antiSlopPlugin;
