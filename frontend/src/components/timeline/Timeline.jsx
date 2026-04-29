import { Reorder, motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import StopCard from './StopCard.jsx';
import TransitStop from './TransitStop.jsx';

export default function Timeline({ day, onReorder, saving, onDelete, onUpdate, days, onMove }) {
  const [expandedId, setExpandedId] = useState(null);
  const [items, setItems] = useState(day?.stops || []);
  const itemsRef = useRef(items);

  useEffect(() => {
    const nextItems = day?.stops || [];
    itemsRef.current = nextItems;
    setItems(nextItems);
  }, [day]);

  const handleReorder = (nextItems) => {
    itemsRef.current = nextItems;
    setItems(nextItems);
  };

  if (!day) return null;

  return (
    <div className="relative pl-2">
      <div className="absolute left-[20px] top-0 bottom-0 w-px" style={{ background: 'linear-gradient(to bottom, rgba(201,168,76,0) 0%, rgba(201,168,76,0.35) 20%, rgba(201,168,76,0.35) 80%, rgba(201,168,76,0) 100%)' }} />
      <Reorder.Group axis="y" values={items} onReorder={handleReorder} className="space-y-4">
        {items.map((stop, index) => (
          <Reorder.Item
            key={stop.id}
            value={stop}
            onDragEnd={() => onReorder(itemsRef.current.map((item) => item.id))}
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
                  onDelete={onDelete}
                  onUpdate={onUpdate}
                  days={days}
                  onMove={onMove}
                />
              ) : (
                <StopCard
                  stop={stop}
                  expanded={expandedId === stop.id}
                  onToggle={(id) => setExpandedId((current) => current === id ? null : id)}
                  onDelete={onDelete}
                  onUpdate={onUpdate}
                  days={days}
                  onMove={onMove}
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
