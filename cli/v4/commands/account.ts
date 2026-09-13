import type { SlashCommand } from '../commandRegistry';
import { safeAccountPortal } from '../../../core/v4/product/accountPortal';
import { openOAuthBrowserUrl } from '../auth/loadProvider';

export const account: SlashCommand = {
  name: 'account',
  description: 'Email-account setup; /account open requests your sign-in portal.',
  category: 'system',
  handler: async ctx => {
    if (ctx.args.length > 1 || (ctx.args[0] && !['status', 'open', 'disconnect'].includes(ctx.args[0]))) {
      ctx.display.write('Usage: /account [status|open|disconnect]. Do not enter your email, password or a sign-in code here.\n');
      return;
    }
    const portal = safeAccountPortal(process.env.AIDEN_BILLING_ORIGIN);
    if (!portal) {
      ctx.display.write('Account sign-in is not enabled for this installation yet. Continue locally with /setup; no account is required for local Core use.\n');
      return;
    }
    const client = ctx.integrationRuntime?.accountClient;
    if (client) {
      try {
        const value = ctx.args[0] === 'open' ? await client.begin('cli')
          : ctx.args[0] === 'disconnect' ? await client.disconnect() : await client.status();
        if (value.state === 'linked') ctx.display.write(`Account linked: ${value.account!.email}\nAccount sign-in does not activate Pro or change your model. /account disconnect to unlink.\n`);
        else if (value.state === 'pending') {
          ctx.display.write(`Confirm this code in your account portal: ${value.userCode}\nOnly approve a request you started. Then run /account status.\n`);
          if (ctx.args[0] === 'open' && value.portal === portal) await openOAuthBrowserUrl(`${portal}/#connect=${value.userCode}`);
        } else ctx.display.write(`Account connection: ${value.state}. Run /account open to sign in. Local use remains available.\n`);
      } catch { ctx.display.write('Account connection could not be completed. Retry or review your account portal; local use is unaffected.\n'); }
      return;
    }
    ctx.display.write(`Aiden account portal: ${portal}\nVerify your email in that browser page. This is separate from model sign-in and paid activation.\n`);
    if (ctx.args[0] === 'open') {
      await openOAuthBrowserUrl(portal);
      ctx.display.write('Browser open requested. If it did not open, use the link above. Return here after verification; opening the page does not establish a local signed-in session.\n');
    } else ctx.display.write('Run /account open to open the portal. This CLI has not verified an account session.\n');
  },
};
