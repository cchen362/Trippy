import DayHeader from '../components/timeline/DayHeader.jsx';
import DayTabs from '../components/timeline/DayTabs.jsx';
import Timeline from '../components/timeline/Timeline.jsx';
import { useTripContext } from './TripPage.jsx';

export default function PlanTab() {
  const {
    days,
    activeDay,
    activeDayId,
    setActiveDayId,
    reorderStops,
    saving,
  } = useTripContext();

  const handleReorder = async (orderedStopIds) => {
    if (!activeDay || orderedStopIds.length === 0) return;
    await reorderStops(activeDay.id, orderedStopIds);
  };

  return (
    <div className="space-y-6">
      <DayTabs days={days} activeDayId={activeDayId} onSelect={setActiveDayId} />
      <DayHeader day={activeDay} dayNumber={days.findIndex((day) => day.id === activeDayId) + 1} />
      <Timeline day={activeDay} onReorder={handleReorder} saving={saving} />
    </div>
  );
}
