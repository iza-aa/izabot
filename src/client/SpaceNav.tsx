import { useEffect, useState } from 'react';
import { ChevronRight, Folder, MoreHorizontal, Plus } from 'lucide-react';
import type { Dot, Space } from '../shared/types';
import { Mascot } from './Mascot';

export function SpaceNav({
  space,
  dots,
  active,
  selectedDot,
  onOpen,
  onDot,
  onEditDot,
  onNewDot,
}: {
  space: Space;
  dots: Dot[];
  active: boolean;
  selectedDot?: string;
  onOpen: () => void;
  onDot: (dot: Dot) => void;
  onEditDot: (dot: Dot) => void;
  onNewDot: () => void;
}) {
  const containsSelected =
    !!selectedDot && dots.some((dot) => dot.id === selectedDot);
  const [expanded, setExpanded] = useState(active || containsSelected);
  useEffect(() => {
    if (active || containsSelected) setExpanded(true);
  }, [active, containsSelected]);
  return (
    <div className={`space-nav-group ${active ? 'space-nav-active' : ''}`}>
      <div className="space-nav-row">
        <button
          className="icon-button space-disclosure"
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${space.name}`}
          aria-expanded={expanded}
          aria-controls={`space-dots-${space.id}`}
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronRight
            size={13}
            style={{ transform: expanded ? 'rotate(90deg)' : undefined }}
          />
        </button>
        <button
          className={`nav-item ${active ? 'active' : ''}`}
          aria-current={active ? 'page' : undefined}
          onClick={onOpen}
        >
          <Folder size={16} />
          <span>{space.name}</span>
          <small>{dots.length}</small>
        </button>
      </div>
      {expanded && (
        <div id={`space-dots-${space.id}`} className="space-dots">
          {dots.map((item) => (
            <div className="dot-nav-row" key={item.id}>
              <button
                className={`dot-nav ${selectedDot === item.id ? 'active' : ''}`}
                aria-current={selectedDot === item.id ? 'page' : undefined}
                onClick={() => onDot(item)}
              >
                <Mascot
                  identity={item.id}
                  avatar={item.avatar}
                  name={item.name}
                  small
                  decorative
                />
                <span>{item.name}</span>
              </button>
              <button
                className="icon-button dot-settings"
                aria-label={`Edit ${item.name}`}
                onClick={() => onEditDot(item)}
              >
                <MoreHorizontal size={15} />
              </button>
            </div>
          ))}
          <button className="nav-item space-new-dot" onClick={onNewDot}>
            <Plus size={14} />
            <span>New Dot</span>
          </button>
        </div>
      )}
    </div>
  );
}
