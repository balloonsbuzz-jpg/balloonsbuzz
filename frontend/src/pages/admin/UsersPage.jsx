import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { UserPlus, DotsThreeVertical, Copy, WhatsappLogo, Plus, Lock, Check } from '@phosphor-icons/react';
import { PageHeader } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';

const useRoles = () => useQuery({ queryKey: ['roles'], queryFn: async () => (await api.get('/roles')).data });
const useTeam = () => useQuery({ queryKey: ['team'], queryFn: async () => (await api.get('/users')).data.users });

export default function UsersPage() {
  const [tab, setTab] = useState('team');
  return (
    <>
      <PageHeader title="Users & Roles" description="Who can sign in to this dashboard and what each person may do." />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4"><TabsTrigger value="team">Team</TabsTrigger><TabsTrigger value="roles">Roles</TabsTrigger></TabsList>
        <TabsContent value="team"><Team /></TabsContent>
        <TabsContent value="roles"><Roles /></TabsContent>
      </Tabs>
    </>
  );
}

// ── Team ──────────────────────────────────────────────────────
function Team() {
  const { user: me, can } = useAuth();
  const canWrite = can('users:write');
  const { data: team = [], isLoading } = useTeam();
  const { data: rolesData } = useRoles();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [link, setLink] = useState(null);       // { name, url, purpose, expires_at }
  const [removing, setRemoving] = useState(null);
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['team'] });
  const act = useMutation({
    mutationFn: async ({ method, url, body }) => (await api[method](url, body)).data,
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const showLink = (u, l) => setLink({ name: u.full_name, phone: u.phone, url: `${window.location.origin}${l.path}`, purpose: l.purpose, expires_at: l.expires_at });

  return (
    <>
      {canWrite && (
        <div className="mb-3 flex justify-end">
          <Button onClick={() => setAdding(true)}><UserPlus size={16} /> Add team member</Button>
        </div>
      )}
      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      <ul className="divide-y rounded-xl border bg-card">
        {team.map((u) => (
          <li key={u.id} className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3', !u.is_active && 'opacity-60')}>
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-gold-200 text-sm font-bold text-[#8f6a22]">{u.full_name[0]?.toUpperCase()}</div>
            <div className="min-w-0 flex-1">
              <p className="truncate font-bold">{u.full_name}{u.id === me.id && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(you)</span>}</p>
              <p className="truncate text-xs text-muted-foreground">{u.email}{u.phone ? ` · +${u.phone}` : ''}</p>
            </div>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-bold">{u.role_name}</span>
            <span className="w-40 text-xs text-muted-foreground">
              {!u.is_active ? 'Deactivated'
                : u.invite_pending ? (u.link_expires_at ? 'Invited, link not used yet' : 'Invite link expired')
                  : u.last_login_at ? `Last seen ${formatDistanceToNow(new Date(u.last_login_at), { addSuffix: true })}` : 'Never signed in'}
            </span>
            {canWrite && (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={`Actions for ${u.full_name}`} />}><DotsThreeVertical size={18} /></DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setEditing(u)}>Edit</DropdownMenuItem>
                  {u.is_active && (
                    <DropdownMenuItem onClick={() => act.mutate({ method: 'post', url: `/users/${u.id}/link` }, { onSuccess: (r) => showLink(u, r.link) })}>
                      {u.invite_pending ? 'New invite link' : 'Password reset link'}
                    </DropdownMenuItem>
                  )}
                  {u.active_sessions > 0 && u.id !== me.id && (
                    <DropdownMenuItem onClick={() => act.mutate({ method: 'post', url: `/users/${u.id}/sign-out` }, { onSuccess: (r) => toast.success(`Signed out of ${r.sessions} device(s)`) })}>
                      Sign out of all devices
                    </DropdownMenuItem>
                  )}
                  {u.id !== me.id && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => act.mutate({ method: 'patch', url: `/users/${u.id}`, body: { is_active: !u.is_active } }, { onSuccess: () => toast.success(u.is_active ? `${u.full_name} can no longer sign in` : `${u.full_name} can sign in again`) })}>
                        {u.is_active ? 'Deactivate' : 'Reactivate'}
                      </DropdownMenuItem>
                      <DropdownMenuItem variant="destructive" onClick={() => setRemoving(u)}>Remove…</DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted-foreground">Deactivating or changing someone’s role signs them out straight away; their name stays on past chats, bookings and the audit log.</p>

      {adding && <AddSheet roles={rolesData?.roles || []} onClose={() => setAdding(false)} onCreated={(u, l) => { setAdding(false); refresh(); showLink(u, l); }} />}
      {editing && <EditSheet u={editing} me={me} roles={rolesData?.roles || []} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
      {link && <LinkDialog link={link} onClose={() => setLink(null)} />}
      {removing && (
        <Dialog open onOpenChange={(o) => !o && setRemoving(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Remove {removing.full_name}?</DialogTitle>
              <DialogDescription>They are signed out and can’t sign in again. Their name stays on past messages, bookings and the audit log. You can invite the same email again later.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setRemoving(null)}>Keep</Button>
              <Button variant="destructive" disabled={act.isPending}
                onClick={() => act.mutate({ method: 'delete', url: `/users/${removing.id}` }, { onSuccess: () => { toast.success(`${removing.full_name} removed`); setRemoving(null); } })}>
                Remove
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function RoleSelect({ roles, value, onChange, disabled, id }) {
  const { user } = useAuth();
  const options = roles.filter((r) => r.key !== 'owner' || user.role === 'owner').map((r) => [r.id, r.name]);
  return <NativeSelect id={id} value={value} onChange={onChange} disabled={disabled} options={options} placeholder="Choose a role…" aria-label="Role" />;
}

function AddSheet({ roles, onClose, onCreated }) {
  const [f, setF] = useState({ full_name: '', email: '', phone: '', role_id: '' });
  useEffect(() => { if (!f.role_id && roles.length) setF((x) => ({ ...x, role_id: roles.find((r) => r.key === 'agent')?.id || '' })); }, [roles]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({
    mutationFn: async () => (await api.post('/users', { ...f, phone: f.phone || null })).data,
    onSuccess: (r) => onCreated(r.user, r.link),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? e.target.value : e }));
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto data-[side=right]:sm:max-w-md">
        <SheetHeader className="pr-12">
          <SheetTitle className="text-lg font-extrabold">Add a team member</SheetTitle>
          <SheetDescription>You’ll get a one-time link to send them (on WhatsApp, for example). They open it and choose their own password.</SheetDescription>
        </SheetHeader>
        <form className="space-y-4 px-4 pb-6" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <Field id="nu-name" label="Name"><Input id="nu-name" value={f.full_name} onChange={set('full_name')} autoFocus /></Field>
          <Field id="nu-email" label="Email (they sign in with it)"><Input id="nu-email" type="email" value={f.email} onChange={set('email')} /></Field>
          <Field id="nu-phone" label="WhatsApp number (optional)" hint="With country code, e.g. 919392534625. Used for team alerts and to send the link.">
            <Input id="nu-phone" inputMode="tel" value={f.phone} onChange={set('phone')} />
          </Field>
          <Field id="nu-role" label="Role"><RoleSelect id="nu-role" roles={roles} value={f.role_id} onChange={set('role_id')} /></Field>
          <Button type="submit" className="w-full" disabled={save.isPending || f.full_name.trim().length < 2 || !f.email || !f.role_id}>Create and get the link</Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function EditSheet({ u, me, roles, onClose, onSaved }) {
  const [f, setF] = useState({ full_name: u.full_name, phone: u.phone || '', role_id: u.role_id });
  const self = u.id === me.id;
  const save = useMutation({
    mutationFn: async () => {
      const body = { full_name: f.full_name, phone: f.phone || null };
      if (!self && f.role_id !== u.role_id) body.role_id = f.role_id;
      return (await api.patch(`/users/${u.id}`, body)).data;
    },
    onSuccess: () => { toast.success(f.role_id !== u.role_id ? `Saved. ${u.full_name} will sign in again with the new role.` : 'Saved'); onSaved(); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? e.target.value : e }));
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto data-[side=right]:sm:max-w-md">
        <SheetHeader className="pr-12">
          <SheetTitle className="text-lg font-extrabold">{u.full_name}</SheetTitle>
          <SheetDescription>{u.email}</SheetDescription>
        </SheetHeader>
        <form className="space-y-4 px-4 pb-6" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <Field id="eu-name" label="Name"><Input id="eu-name" value={f.full_name} onChange={set('full_name')} /></Field>
          <Field id="eu-phone" label="WhatsApp number" hint="With country code, e.g. 919392534625"><Input id="eu-phone" inputMode="tel" value={f.phone} onChange={set('phone')} /></Field>
          <Field id="eu-role" label="Role" hint={self ? 'You can’t change your own role.' : 'Changing the role signs them out so the new permissions apply.'}>
            <RoleSelect id="eu-role" roles={roles} value={f.role_id} onChange={set('role_id')} disabled={self} />
          </Field>
          <Button type="submit" className="w-full" disabled={save.isPending || f.full_name.trim().length < 2}>Save</Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function LinkDialog({ link, onClose }) {
  const [copied, setCopied] = useState(false);
  const invite = link.purpose === 'invite';
  const message = invite
    ? `Hi ${link.name.split(' ')[0]}, you've been added to the BalloonsBuzz dashboard. Open this link to set your password (it works once): ${link.url}`
    : `Hi ${link.name.split(' ')[0]}, here is a link to set a new password for the BalloonsBuzz dashboard (it works once): ${link.url}`;
  const copy = async () => {
    try { await navigator.clipboard.writeText(link.url); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { toast.error('Copy failed: select the link and copy it'); }
  };
  const wa = `https://wa.me/${link.phone || ''}?text=${encodeURIComponent(message)}`;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{invite ? `Send ${link.name} their invite` : `Password reset link for ${link.name}`}</DialogTitle>
          <DialogDescription>
            Works once, until {new Date(link.expires_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}. This is the only time it’s shown; make a new one any time from the ⋮ menu.
          </DialogDescription>
        </DialogHeader>
        <p className="break-all rounded-lg bg-muted px-3 py-2 font-mono text-xs" aria-label="Link">{link.url}</p>
        <DialogFooter className="gap-2 sm:justify-start">
          <Button onClick={copy} variant="outline">{copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copied' : 'Copy link'}</Button>
          <a href={wa} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#25D366] px-3 text-sm font-semibold text-white hover:bg-[#1ebe5a]">
            <WhatsappLogo size={16} weight="fill" /> Send on WhatsApp
          </a>
          <Button variant="ghost" onClick={onClose} className="sm:ml-auto">Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ id, label, hint, children }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

// ── Roles ─────────────────────────────────────────────────────
function Roles() {
  const { can } = useAuth();
  const canWrite = can('users:write');
  const { data } = useRoles();
  const [editing, setEditing] = useState(null);  // role object, or {} for new
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return (
    <>
      {canWrite && <div className="mb-3 flex justify-end"><Button variant="outline" onClick={() => setEditing({})}><Plus size={16} /> New role</Button></div>}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {data.roles.map((r) => (
          <article key={r.id} className="rounded-xl border bg-card p-4">
            <div className="flex items-center gap-2">
              <p className="font-bold">{r.name}</p>
              {r.is_system && <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Lock size={12} /> built in</span>}
              <span className="ml-auto text-xs text-muted-foreground">{r.members} {r.members === 1 ? 'person' : 'people'}</span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{summary(r, data.permissions)}</p>
            {canWrite && !r.is_system && <Button size="sm" variant="ghost" className="mt-2 -ml-2" onClick={() => setEditing(r)}>Edit</Button>}
            {r.is_system && <Button size="sm" variant="ghost" className="mt-2 -ml-2" onClick={() => setEditing({ ...r, readOnly: true })}>View permissions</Button>}
          </article>
        ))}
      </div>
      {editing && <RoleSheet role={editing} catalogue={data.permissions} onClose={() => setEditing(null)} />}
    </>
  );
}

function summary(r, catalogue) {
  if (r.permissions.includes('*')) return 'Everything, including team members and settings.';
  const groups = catalogue.filter(([, list]) => list.some(([k]) => r.permissions.includes(k))).map(([g]) => g);
  return groups.length ? `Can use: ${groups.join(', ')}.` : 'No permissions.';
}

function RoleSheet({ role, catalogue, onClose }) {
  const qc = useQueryClient();
  const isNew = !role.id;
  const all = role.permissions?.includes('*');
  const [name, setName] = useState(role.name || '');
  const [perms, setPerms] = useState(new Set(role.permissions || ['dashboard:read']));
  const readOnly = !!role.readOnly;
  const save = useMutation({
    mutationFn: async () => {
      const body = { name, permissions: [...perms] };
      return isNew ? (await api.post('/roles', body)).data : (await api.patch(`/roles/${role.id}`, body)).data;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['roles'] }); toast.success(isNew ? 'Role created' : 'Role saved. People with it get the change at their next sign-in.'); onClose(); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const del = useMutation({
    mutationFn: async () => (await api.delete(`/roles/${role.id}`)).data,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['roles'] }); toast.success('Role deleted'); onClose(); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const toggle = (k) => setPerms((s) => {
    const n = new Set(s);
    if (n.has(k)) n.delete(k); else n.add(k);
    // writing implies reading the same area
    if (n.has(k) && k.endsWith(':write')) n.add(k.replace(':write', ':read'));
    return n;
  });
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto data-[side=right]:sm:max-w-lg">
        <SheetHeader className="pr-12">
          <SheetTitle className="text-lg font-extrabold">{isNew ? 'New role' : role.name}</SheetTitle>
          <SheetDescription>{readOnly ? 'Built-in roles can’t be changed. Create a custom role for a different mix.' : 'Tick what people with this role may do.'}</SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-6">
          {!readOnly && <div className="space-y-1.5"><Label htmlFor="role-name">Name</Label><Input id="role-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Decor crew" /></div>}
          {all && <p className="rounded-lg bg-accent px-3 py-2 text-sm text-accent-foreground">Owners can do everything.</p>}
          {!all && catalogue.map(([group, list]) => (
            <fieldset key={group}>
              <legend className="mb-1.5 text-xs font-extrabold tracking-wide text-muted-foreground">{group.toUpperCase()}</legend>
              <div className="space-y-1">
                {list.map(([k, label]) => (
                  <label key={k} className={cn('flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm', !readOnly && 'cursor-pointer hover:bg-muted')}>
                    <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={perms.has(k)} disabled={readOnly} onChange={() => toggle(k)} />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
          {!readOnly && (
            <div className="flex gap-2 pt-2">
              <Button className="flex-1" disabled={save.isPending || name.trim().length < 2 || !perms.size} onClick={() => save.mutate()}>{isNew ? 'Create role' : 'Save'}</Button>
              {!isNew && <Button variant="ghost" className="text-destructive" disabled={del.isPending} onClick={() => del.mutate()}>Delete</Button>}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
