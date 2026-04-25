import { useCallback, useEffect, useState } from 'react';
import { tripsApi } from '../services/tripsApi.js';

export function useCollaboration(tripId, enabled = true) {
  const [data, setData] = useState(null);
  const [shareLink, setShareLink] = useState(null);
  const [loading, setLoading] = useState(Boolean(enabled));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!tripId || !enabled) return;
    setLoading(true);
    setError(null);
    try {
      setData(await tripsApi.collaborators(tripId));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [enabled, tripId]);

  useEffect(() => {
    load();
  }, [load]);

  const invite = useCallback(async (username) => {
    setSaving(true);
    setError(null);
    try {
      await tripsApi.inviteCollaborator(tripId, username);
      await load();
    } catch (err) {
      setError(err);
      throw err;
    } finally {
      setSaving(false);
    }
  }, [load, tripId]);

  const remove = useCallback(async (userId) => {
    setSaving(true);
    setError(null);
    try {
      await tripsApi.removeCollaborator(tripId, userId);
      await load();
    } catch (err) {
      setError(err);
      throw err;
    } finally {
      setSaving(false);
    }
  }, [load, tripId]);

  const createShare = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const link = await tripsApi.createShareLink(tripId);
      setShareLink(link);
      return link;
    } catch (err) {
      setError(err);
      throw err;
    } finally {
      setSaving(false);
    }
  }, [tripId]);

  return {
    owner: data?.owner || null,
    collaborators: data?.collaborators || [],
    canManage: Boolean(data?.canManage),
    shareLink,
    loading,
    saving,
    error,
    invite,
    remove,
    createShare,
    refresh: load,
  };
}
