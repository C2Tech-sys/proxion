import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect } from '@/components/hardware/NativeSelect';
import { useUpdateCloudInit } from '@/api/cloudInitHooks';
import { hardwareErrorMessage } from '@/api/hardwareHooks';
import type { CloudInitType, CloudInitUpdate } from '@/api/cloudInit';
import { decodeSshKeys, isIPv4, isIPv6 } from '@/lib/pve-config';
import type { GuestConfig } from '@/api/types';

/** The single-value cloud-init settings this dialog edits (the IP config has its own dialog). */
export type CloudInitSettingKind = 'user' | 'password' | 'searchdomain' | 'nameserver' | 'sshKeys' | 'upgrade' | 'type';

export interface CloudInitSettingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  vmid: number;
  kind: CloudInitSettingKind;
  config: GuestConfig;
}

// These mirror the server route's own schema (`apps/server/src/actions/cloudInitRoutes.ts`).
const USER_RE = /^[a-z_][a-z0-9_-]*$/;
const DNS_NAME_RE = /^(?=.{1,255}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const SSH_KEY_RE =
  /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/=]+( [^\r\n]{0,256})?$/;
const MAX_NAMESERVERS = 3;

const TITLES: Record<CloudInitSettingKind, string> = {
  user: 'Edit user',
  password: 'Edit password',
  searchdomain: 'Edit DNS domain',
  nameserver: 'Edit DNS servers',
  sshKeys: 'Edit SSH public keys',
  upgrade: 'Edit upgrade packages',
  type: 'Edit type',
};

const DESCRIPTIONS: Record<CloudInitSettingKind, string> = {
  user: 'The user account cloud-init creates (and the default user of the image). Leave blank to use the image default.',
  password: 'Proxmox hashes the password before it is stored. It is never shown again.',
  searchdomain: 'The DNS search domain. Leave blank to use the host setting.',
  nameserver: 'Up to three DNS servers, separated by spaces. Leave blank to use the host setting.',
  sshKeys: 'One OpenSSH public key per line. Leave blank to remove all keys.',
  upgrade: 'Whether cloud-init upgrades the guest’s packages on its first boot.',
  type: 'The cloud-init configuration format. Leave on the default unless the guest image needs another.',
};

/** Whitespace/comma separated DNS server text -> the list. */
function splitServers(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function splitKeys(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function Field({ label, htmlFor, error, hint, children }: {
  label: string;
  htmlFor: string;
  error?: string | undefined;
  hint?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-status-error">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/**
 * Edits one single-value cloud-init setting: user, password (+ confirmation), DNS domain, DNS
 * servers, SSH public keys, upgrade packages or type. Validation mirrors the server route's, shown
 * inline; a server error stays inline and the dialog stays open. A blank field removes the setting
 * (`null` / `[]`); only the setting being edited is sent, so nothing else is touched.
 *
 * The password lives in this dialog's state only for as long as it is open: it is sent in the
 * request body, never put in a toast, an error line or the query cache, and the dialog is mounted
 * fresh per open (the tab renders it conditionally), so it is gone when the dialog closes.
 */
export function CloudInitSettingDialog({ open, onOpenChange, node, vmid, kind, config }: CloudInitSettingDialogProps) {
  const id = useId();
  const mutation = useUpdateCloudInit();
  const busy = mutation.isPending;

  const currentUser = typeof config.ciuser === 'string' ? config.ciuser : '';
  const currentDomain = typeof config.searchdomain === 'string' ? config.searchdomain : '';
  const currentServers = typeof config.nameserver === 'string' ? config.nameserver : '';
  const currentKeys = decodeSshKeys(config.sshkeys);
  // PVE's own default is to upgrade on first boot.
  const currentUpgrade = config.ciupgrade === undefined ? true : String(config.ciupgrade) !== '0';
  const currentType = typeof config.citype === 'string' ? config.citype : '';
  const passwordSet = config.cipassword !== undefined;

  const [userText, setUserText] = useState(currentUser);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [domainText, setDomainText] = useState(currentDomain);
  const [serversText, setServersText] = useState(currentServers);
  const [keysText, setKeysText] = useState(currentKeys.join('\n'));
  const [upgrade, setUpgrade] = useState(currentUpgrade);
  const [typeValue, setTypeValue] = useState(currentType);

  let error: string | undefined;
  let body: CloudInitUpdate | undefined;

  switch (kind) {
    case 'user': {
      const user = userText.trim();
      if (user !== '' && (user.length > 64 || !USER_RE.test(user))) {
        error = 'Use lowercase letters, digits, "_" and "-", starting with a letter or "_" (at most 64 characters).';
      } else if (user !== currentUser) {
        body = { user: user === '' ? null : user };
      }
      break;
    }
    case 'password': {
      if (password !== '' && password.length > 256) error = 'The password can be at most 256 characters.';
      else if (confirm !== '' && password !== confirm) error = 'The passwords do not match.';
      else if (password !== '' && confirm === password) body = { password };
      break;
    }
    case 'searchdomain': {
      const domain = domainText.trim();
      if (domain !== '' && !DNS_NAME_RE.test(domain)) error = 'Enter a valid DNS domain, e.g. lab.example.com.';
      else if (domain !== currentDomain) body = { searchdomain: domain === '' ? null : domain };
      break;
    }
    case 'nameserver': {
      const servers = splitServers(serversText);
      if (servers.length > MAX_NAMESERVERS) error = `At most ${MAX_NAMESERVERS} DNS servers.`;
      else if (servers.some((s) => !isIPv4(s) && !isIPv6(s))) error = 'Each DNS server must be an IPv4 or IPv6 address.';
      else if (servers.join(' ') !== splitServers(currentServers).join(' ')) body = { nameserver: servers };
      break;
    }
    case 'sshKeys': {
      const keys = splitKeys(keysText);
      const bad = keys.findIndex((k) => !SSH_KEY_RE.test(k));
      if (bad !== -1) error = `Line ${bad + 1} is not an OpenSSH public key (e.g. "ssh-ed25519 AAAA... user@host").`;
      else if (keys.join('\n') !== currentKeys.join('\n')) body = { sshKeys: keys };
      break;
    }
    case 'upgrade': {
      if (upgrade !== currentUpgrade) body = { upgrade };
      break;
    }
    case 'type': {
      if (typeValue !== currentType) body = { type: typeValue === '' ? null : (typeValue as CloudInitType) };
      break;
    }
  }

  const canSave = error === undefined && body !== undefined && !busy;
  const serverError = mutation.isError
    ? hardwareErrorMessage(mutation.error, 'The Cloud-Init setting could not be saved.')
    : undefined;

  function submit(update: CloudInitUpdate | undefined = body) {
    if (update === undefined || busy) return;
    mutation.mutate({ node, vmid, body: update }, { onSuccess: () => onOpenChange(false) });
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement && canSave) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent onKeyDown={onKeyDown} className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{TITLES[kind]}</DialogTitle>
          <DialogDescription>{DESCRIPTIONS[kind]}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {kind === 'user' && (
            <Field label="User" htmlFor={`${id}-user`} error={error}>
              <Input
                id={`${id}-user`}
                value={userText}
                onChange={(e) => setUserText(e.target.value)}
                disabled={busy}
                aria-invalid={error !== undefined || undefined}
                autoComplete="off"
                placeholder="debian"
              />
            </Field>
          )}

          {kind === 'password' && (
            <>
              <Field label="Password" htmlFor={`${id}-password`}>
                <Input
                  id={`${id}-password`}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                  autoComplete="new-password"
                />
              </Field>
              <Field label="Confirm password" htmlFor={`${id}-confirm`} error={error}>
                <Input
                  id={`${id}-confirm`}
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  disabled={busy}
                  aria-invalid={error !== undefined || undefined}
                  autoComplete="new-password"
                />
              </Field>
            </>
          )}

          {kind === 'searchdomain' && (
            <Field label="DNS domain" htmlFor={`${id}-domain`} error={error}>
              <Input
                id={`${id}-domain`}
                value={domainText}
                onChange={(e) => setDomainText(e.target.value)}
                disabled={busy}
                aria-invalid={error !== undefined || undefined}
                autoComplete="off"
                placeholder="lab.example.com"
              />
            </Field>
          )}

          {kind === 'nameserver' && (
            <Field label="DNS servers" htmlFor={`${id}-servers`} error={error}>
              <Input
                id={`${id}-servers`}
                value={serversText}
                onChange={(e) => setServersText(e.target.value)}
                disabled={busy}
                aria-invalid={error !== undefined || undefined}
                autoComplete="off"
                placeholder="1.1.1.1 8.8.8.8"
              />
            </Field>
          )}

          {kind === 'sshKeys' && (
            <Field label="SSH public keys" htmlFor={`${id}-keys`} error={error}>
              <Textarea
                id={`${id}-keys`}
                value={keysText}
                onChange={(e) => setKeysText(e.target.value)}
                disabled={busy}
                aria-invalid={error !== undefined || undefined}
                rows={6}
                spellCheck={false}
                className="font-mono text-xs"
                placeholder="ssh-ed25519 AAAA... user@host"
              />
            </Field>
          )}

          {kind === 'upgrade' && (
            <div className="flex items-center gap-2">
              <Checkbox
                id={`${id}-upgrade`}
                checked={upgrade}
                onCheckedChange={(c) => setUpgrade(c === true)}
                disabled={busy}
              />
              <label htmlFor={`${id}-upgrade`} className="text-sm">
                Upgrade packages on first boot
              </label>
            </div>
          )}

          {kind === 'type' && (
            <Field label="Type" htmlFor={`${id}-type`}>
              <NativeSelect
                id={`${id}-type`}
                value={typeValue}
                onChange={(e) => setTypeValue(e.target.value)}
                disabled={busy}
              >
                <option value="">Default</option>
                <option value="nocloud">nocloud</option>
                <option value="configdrive2">configdrive2</option>
                <option value="opennebula">opennebula</option>
              </NativeSelect>
            </Field>
          )}

          {serverError && (
            <p role="alert" className="text-xs text-status-error">
              {serverError}
            </p>
          )}
        </div>

        <DialogFooter>
          {kind === 'password' && passwordSet && (
            <Button
              variant="outline"
              className="sm:mr-auto"
              disabled={busy}
              onClick={() => submit({ password: null })}
            >
              Remove password
            </Button>
          )}
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSave} onClick={() => submit()}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
