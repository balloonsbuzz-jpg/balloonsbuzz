import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** Packages (design categories), themes with aliases, occasions. */
export function useCatalog() {
  return useQuery({ queryKey: ['catalog'], queryFn: async () => (await api.get('/pricing/catalog')).data, staleTime: 60_000 });
}

export function catalogOptions(catalog) {
  if (!catalog) return { packages: [], designs: [], themes: [], occasions: [] };
  return {
    packages: catalog.packages.map((p) => [p.id, p.name]),
    designs: catalog.packages.filter((p) => p.kind === 'package').map((p) => [p.id, p.name]),
    addons: catalog.packages.filter((p) => p.kind !== 'package').map((p) => [p.id, p.name]),
    themes: catalog.themes.filter((t) => t.is_active).map((t) => [t.id, t.name]),
    occasions: catalog.occasions.map((o) => [o.id, o.name]),
  };
}
