import { DOT_AVATARS } from '../shared/types';

const characters = DOT_AVATARS;

/** Stable identity keeps each Dot recognizable across views and reloads. */
function characterFor(identity?: string, avatar?: string | null) {
  if (avatar && (characters as readonly string[]).includes(avatar))
    return avatar;
  if (!identity) return characters[0];
  let hash = 0;
  for (const character of identity)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return characters[hash % characters.length];
}

export function Mascot({
  state = 'idle',
  small = false,
  identity,
  avatar,
  name = 'Dot',
  decorative = false,
}: {
  state?: string;
  small?: boolean;
  identity?: string;
  avatar?: string | null;
  name?: string;
  decorative?: boolean;
}) {
  return (
    <span className={`mascot ${state} ${small ? 'small' : ''}`}>
      <img
        className="dot-body"
        src={`/dots/${characterFor(identity, avatar)}.png`}
        alt={decorative ? '' : `${name} is ${state}`}
        width={512}
        height={512}
        draggable={false}
      />
    </span>
  );
}
