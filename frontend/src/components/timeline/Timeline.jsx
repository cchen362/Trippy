import { Reorder, motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import StopCard from './StopCard.jsx';
import TransitStop from './TransitStop.jsx';

export default function Timeline({ day, onReorder, saving }) {
  const [expandedId, setExpandedId] = useState(null);
  const [items, setItems] = useState(day?.stops || []);

  useEffect(() => {
    setItems(day?.stops || []);
  }, [day]);

  if (!day) return null;

  return (
    <div className="relative pl-2">
      <div className="absolute left-[12px] top-0 bottom-0 w-px" style={{ background: 'rgba(240,234,216,0.1)' }} />
      <Reorder.Group axis="y" values={items} onReorder={setItems} className="space-y-4">
        {items.map((stop, index) => (
          <Reorder.Item
            key={stop.id}
            value={stop}
            onDragEnd={() => onReorder(items.map((item) => item.id))}
            as="div"
            className="list-none"
          >
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.05 }}
            >
              {stop.type === 'transit' ? (
                <TransitStop
                  stop={stop}
                  index={index}
                  expanded={expandedId === stop.id}
                  onExpand={(id) => setExpandedId((current) => current === id ? null : id)}
                />
              ) : (
                <StopCard
                  stop={stop}
                  expanded={expandedId === stop.id}
                  onToggle={(id) => setExpandedId((current) => current === id ? null : id)}
                />
              )}
            </motion.div>
          </Reorder.Item>
        ))}
      </Reorder.Group>
      {saving && (
        <p className="mt-4 font-mono text-[11px] tracking-[0.22em] uppercase" style={{ color: 'var(--cream-mute)' }}>
          Saving order...
        </p>
      )}
    </div>
  );
}
