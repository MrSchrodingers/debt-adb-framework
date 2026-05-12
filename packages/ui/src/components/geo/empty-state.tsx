export function EmptyState() {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-8 text-center">
      <h3 className="text-sm font-medium text-zinc-300">Nenhuma visão geográfica ativa</h3>
      <p className="mt-2 text-xs text-zinc-500 max-w-md mx-auto">
        Habilite um plugin com visão geográfica em <code className="text-zinc-300">/admin</code>.
        Plugins ativos contribuem suas próprias views automaticamente.
      </p>
    </div>
  )
}
