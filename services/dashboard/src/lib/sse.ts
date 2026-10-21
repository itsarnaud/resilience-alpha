/** Un événement d'un flux SSE (Server-Sent Events) : `event: <nom>\ndata: <JSON>\n\n`. */
export interface SseEvent {
  event: string;
  data: unknown;
}

/**
 * Découpe un flux en événements, bloc par bloc (séparés par une ligne vide). `EventSource` ne sait
 * pas envoyer d'en-tête `Authorization` : on lit donc le flux nous-mêmes avec `fetch`.
 */
export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      // eslint-disable-next-line no-cond-assign
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        let event = 'message';
        const dataLines: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) continue; // commentaire (ping)
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) continue;
        try {
          yield { event, data: JSON.parse(dataLines.join('\n')) };
        } catch {
          // ligne de données illisible : ignorée plutôt que de casser le flux
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
