export const when = (t: number) => new Date(t).toLocaleString();

export const phWhen = (t: number) =>
  new Date(t).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
