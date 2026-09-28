'use client';

import { useEffect, useState } from 'react';
import type { GuardianListResponse, StudentGuardianLink, StudentGuardianListResponse } from '@sms/contracts';
import { Button, Card } from '@sms/ui';
import { clientFetch } from '@/lib/http';
import type { DetailPermissions } from '../student-detail';

const RELATION_LABELS: Record<string, string> = {
  father: 'Father',
  mother: 'Mother',
  parent: 'Parent',
  guardian: 'Guardian',
  other: 'Other',
};

interface GuardiansTabProps {
  studentId: string;
  permissions: DetailPermissions;
}

interface PickedGuardian {
  id: string;
  label: string;
}

export function GuardiansTab({ studentId, permissions }: GuardiansTabProps) {
  const canLink = permissions.canUpdate && permissions.canReadGuardians;
  const canCreateGuardian = permissions.canCreateGuardian && canLink;

  const [links, setLinks] = useState<StudentGuardianLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // search
  const [q, setQ] = useState('');
  const [results, setResults] = useState<PickedGuardian[]>([]);
  const [searched, setSearched] = useState(false);
  const [chosen, setChosen] = useState<PickedGuardian | null>(null);
  const [relation, setRelation] = useState('parent');
  const [isPrimary, setIsPrimary] = useState(false);
  const [canPickup, setCanPickup] = useState(false);

  // create guardian
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  async function load() {
    setError(null);
    try {
      const res = await clientFetch<StudentGuardianListResponse>(`/api/v1/students/${encodeURIComponent(studentId)}/guardians?limit=100&offset=0`);
      setLinks(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load guardians');
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentId]);

  async function search() {
    setError(null);
    setMessage(null);
    if (q.trim() === '') return;
    setSearched(true);
    setBusy(true);
    try {
      const res = await clientFetch<GuardianListResponse>(`/api/v1/guardians?q=${encodeURIComponent(q.trim())}&limit=10&offset=0`);
      setResults(res.items.map((g) => ({ id: g.id, label: `${g.firstName} ${g.lastName}${g.email ? ` (${g.email})` : ''}` })));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setBusy(false);
    }
  }

  async function link() {
    setError(null);
    setMessage(null);
    if (!chosen) {
      setError('Pick a guardian from the search results');
      return;
    }
    setBusy(true);
    try {
      await clientFetch<{ link: StudentGuardianLink }>(`/api/v1/students/${encodeURIComponent(studentId)}/guardians`, {
        method: 'POST',
        body: { guardianId: chosen.id, relation, isPrimary, canPickup },
        includeCsrf: true,
      });
      setMessage(`Linked ${chosen.label}.`);
      setChosen(null);
      setResults([]);
      setSearched(false);
      setQ('');
      setIsPrimary(false);
      setCanPickup(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Link failed');
    } finally {
      setBusy(false);
    }
  }

  async function unlink(linkToRemove: StudentGuardianLink) {
    if (!window.confirm(`Remove ${linkToRemove.guardian.firstName} ${linkToRemove.guardian.lastName} from this student? This only unlinks the guardian record — it does not delete the guardian.`)) return;
    setError(null);
    setMessage(null);
    try {
      const res = await clientFetch<void>(`/api/v1/students/${encodeURIComponent(studentId)}/guardians/${encodeURIComponent(linkToRemove.guardianId)}`, {
        method: 'DELETE',
        includeCsrf: true,
      });
      if (res !== undefined && res !== null && typeof res === 'object') {
        setError('Unexpected response while unlinking.');
        return;
      }
      setLinks((prev) => (prev ? prev.filter((l) => l.guardianId !== linkToRemove.guardianId) : prev));
      setMessage('Guardian unlinked (guardian record kept).');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unlink failed');
    }
  }

  async function createAndLink() {
    setError(null);
    setMessage(null);
    if (!firstName.trim() || !lastName.trim()) {
      setError('First name and last name are required');
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, string> = { firstName: firstName.trim(), lastName: lastName.trim() };
      if (email.trim() !== '') body.email = email.trim();
      if (phone.trim() !== '') body.phone = phone.trim();
      const res = await clientFetch<{ guardian: { id: string; firstName: string; lastName: string } }>('/api/v1/guardians', {
        method: 'POST',
        body,
        includeCsrf: true,
      });
      await clientFetch<{ link: StudentGuardianLink }>(`/api/v1/students/${encodeURIComponent(studentId)}/guardians`, {
        method: 'POST',
        body: { guardianId: res.guardian.id, relation, isPrimary, canPickup },
        includeCsrf: true,
      });
      setMessage(`Guardian ${res.guardian.firstName} ${res.guardian.lastName} created and linked.`);
      setShowCreate(false);
      setFirstName('');
      setLastName('');
      setEmail('');
      setPhone('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="text-lg font-semibold">Guardians</h2>
      {message && <p className="mt-3 text-sm text-green-600">{message}</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {links === null ? (
        <p className="mt-3 text-sm text-gray-500">Loading…</p>
      ) : links.length === 0 ? (
        <p className="mt-3 text-sm text-gray-500">No guardians linked yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-gray-100">
          {links.map((link) => (
            <li key={link.id} className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {link.guardian.firstName} {link.guardian.lastName}
                </p>
                <p className="text-xs text-gray-500">
                  {RELATION_LABELS[link.relation] ?? link.relation}
                  {link.isPrimary && ' · Primary'}
                  {link.canPickup && ' · Can pick up'}
                  {link.guardian.email && ` · ${link.guardian.email}`}
                </p>
              </div>
              {canLink && (
                <Button type="button" size="small" variant="danger" onClick={() => void unlink(link)}>
                  Unlink
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canLink && (
        <div className="mt-6 border-t border-gray-100 pt-4">
          <h3 className="text-sm font-semibold">Link an existing guardian</h3>
          <div className="mt-2 flex gap-3">
            <input
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              placeholder="Search by guardian name or email"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void search();
              }}
            />
            <Button type="button" size="small" disabled={busy} onClick={() => void search()}>
              Search
            </Button>
          </div>

          {searched && results.length === 0 && <p className="mt-2 text-sm text-gray-500">No guardians found.</p>}
          {results.length > 0 && (
            <ul className="mt-2 divide-y divide-gray-100">
              {results.map((g) => (
                <li key={g.id} className="flex items-center justify-between py-2">
                  <span className="text-sm">{g.label}</span>
                  <Button type="button" size="small" onClick={() => setChosen(g)}>
                    {chosen?.id === g.id ? 'Selected' : 'Select'}
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {chosen && (
            <div className="mt-3 grid gap-3 sm:grid-cols-4">
              <label className="block">
                <span className="text-xs text-gray-600">Relation</span>
                <select className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={relation} onChange={(e) => setRelation(e.target.value)}>
                  <option value="father">Father</option>
                  <option value="mother">Mother</option>
                  <option value="parent">Parent</option>
                  <option value="guardian">Guardian</option>
                  <option value="other">Other</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} />
                Primary
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={canPickup} onChange={(e) => setCanPickup(e.target.checked)} />
                Can pick up
              </label>
              <Button type="button" size="small" disabled={busy} onClick={() => void link()}>
                Link {chosen.label}
              </Button>
            </div>
          )}

          {canCreateGuardian && (
            <div className="mt-4">
              <button type="button" className="text-sm text-blue-600 hover:underline" onClick={() => setShowCreate((v) => !v)}>
                {showCreate ? 'Cancel new guardian' : 'Or create a new guardian and link it'}
              </button>
              {showCreate && (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="text-xs text-gray-600">First name</span>
                    <input className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
                  </label>
                  <label className="block">
                    <span className="text-xs text-gray-600">Last name</span>
                    <input className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={lastName} onChange={(e) => setLastName(e.target.value)} />
                  </label>
                  <label className="block">
                    <span className="text-xs text-gray-600">Email</span>
                    <input className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={email} onChange={(e) => setEmail(e.target.value)} />
                  </label>
                  <label className="block">
                    <span className="text-xs text-gray-600">Phone</span>
                    <input className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={phone} onChange={(e) => setPhone(e.target.value)} />
                  </label>
                  <div>
                    <Button type="button" size="small" disabled={busy} onClick={() => void createAndLink()}>
                      Create &amp; link
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}