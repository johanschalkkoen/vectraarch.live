import React, { useState, useMemo } from 'react';

// ── Profile definitions — mirrors web app user system ──
const PROFILES = [
  { id: 'female', name: 'Female Koen', short: 'F.KOEN', color: '#e91e8c', img: '/images/female.jpg' },
  { id: 'male',   name: 'Male Koen',   short: 'M.KOEN', color: '#6a8aff', img: '/images/male.jpg'   },
  { id: 'girl',   name: 'Girl Koen',   short: 'G.KOEN', color: '#1de9b6', img: '/images/girl.png'   },
  { id: 'boy',    name: 'Boy Koen',    short: 'B.KOEN', color: '#00e676', img: '/images/boy.png'    },
];

// ── Tab definitions ──
const TABS = [
  { id: 'finances', label: 'FIN',  color: '#00e676', icon: FinIcon  },
  { id: 'calendar', label: 'CAL',  color: '#e91e8c', icon: CalIcon  },
  { id: 'budget',   label: 'BUD',  color: '#ffd600', icon: BudIcon  },
  { id: 'gym',      label: 'GYM',  color: '#6a8aff', icon: GymIcon  },
  { id: 'meals',    label: 'NUT',  color: '#1de9b6', icon: MealIcon },
  { id: 'cycle',    label: 'CYC',  color: '#e91e8c', icon: CycIcon  },
  { id: 'profile',  label: 'PRO',  color: '#a0a4a8', icon: ProIcon  },
];

const DAYS_SHORT = ['MON','TUE','WED','THU','FRI','SAT','SUN'];
const MONTHS_LONG = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];

// ── Inline SVG icons ──
function FinIcon({ size = 20, color = 'currentColor' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" width={size} height={size}>
      <rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>
    </svg>
  );
}
function CalIcon({ size = 20, color = 'currentColor' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" width={size} height={size}>
      <rect x="3" y="4" width="18" height="18" rx="2"/>
      <line x1="16" y1="2" x2="16" y2="6"/>
      <line x1="8" y1="2" x2="8" y2="6"/>
      <line x1="3" y1="10" x2="21" y2="10"/>
    </svg>
  );
}
function BudIcon({ size = 20, color = 'currentColor' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" width={size} height={size}>
      <rect x="2" y="3" width="8" height="8" rx="1"/>
      <rect x="14" y="3" width="8" height="8" rx="1"/>
      <rect x="2" y="13" width="8" height="8" rx="1"/>
      <rect x="14" y="13" width="8" height="8" rx="1"/>
    </svg>
  );
}
function GymIcon({ size = 20, color = 'currentColor' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" width={size} height={size}>
      <path d="M6 4v16M18 4v16M2 9h4M18 9h4M2 15h4M18 15h4M6 12h12"/>
    </svg>
  );
}
function MealIcon({ size = 20, color = 'currentColor' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" width={size} height={size}>
      <path d="M18 8h1a4 4 0 0 1 0 8h-1"/>
      <path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/>
      <line x1="6" y1="1" x2="6" y2="4"/>
      <line x1="10" y1="1" x2="10" y2="4"/>
      <line x1="14" y1="1" x2="14" y2="4"/>
    </svg>
  );
}
function CycIcon({ size = 20, color = 'currentColor' }) {
  return (
    <svg viewBox="0 0 24 24" fill={color} width={size} height={size}>
      <path d="M12 2C12 2 5 10.5 5 15a7 7 0 0 0 14 0C19 10.5 12 2 12 2z" opacity="0.9"/>
    </svg>
  );
}
function ProIcon({ size = 20, color = 'currentColor' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" width={size} height={size}>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
      <circle cx="12" cy="7" r="4"/>
    </svg>
  );
}
function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="var(--text3)" strokeWidth="2.5" width={13} height={13}>
      <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
    </svg>
  );
}
function PlusIcon({ color = '#fff' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" width={16} height={16}>
      <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
  );
}

// ── Placeholder avatar circle ──
function AvatarCircle({ color, initial, img, size = 28 }: { color: string; initial: string; img?: string; size?: number }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      background: img ? undefined : `${color}22`,
      border: `2px solid ${color}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      overflow: 'hidden',
    }}>
      {img
        ? <img src={img} alt={initial} style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}/>
        : <span style={{ fontFamily: "'DM Mono', monospace", fontSize: size * 0.38, fontWeight: 600, color }}>{initial}</span>
      }
    </div>
  );
}

// ── Calendar helpers ──
function getDaysInMonth(year: number, month: number) { return new Date(year, month + 1, 0).getDate(); }
function getFirstDayOfWeek(year: number, month: number) {
  const d = new Date(year, month, 1).getDay();
  return d === 0 ? 6 : d - 1; // Monday = 0
}

// ── Calendar Page ──
function CalendarPage({ activeProfiles, onToggleProfile }: { activeProfiles: Set<string>; onToggleProfile: (id: string) => void }) {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [selectedDay, setSelectedDay] = useState<number | null>(today.getDate());
  const [search, setSearch] = useState('');

  const daysInMonth = getDaysInMonth(year, month);
  const firstDow = getFirstDayOfWeek(year, month);

  const prevMonth = () => { if (month === 0) { setYear(y => y - 1); setMonth(11); } else setMonth(m => m - 1); };
  const nextMonth = () => { if (month === 11) { setYear(y => y + 1); setMonth(0); } else setMonth(m => m + 1); };
  const goToday   = () => { setYear(today.getFullYear()); setMonth(today.getMonth()); setSelectedDay(today.getDate()); };

  // Demo event dots per day
  const dotMap: Record<number, string[]> = useMemo(() => ({
    6:  [PROFILES[1].color, PROFILES[2].color, PROFILES[3].color],
    13: [PROFILES[0].color, PROFILES[1].color],
    20: [PROFILES[0].color, PROFILES[2].color, PROFILES[3].color],
    21: PROFILES.map(p => p.color),
  }), []);

  // Demo events for selected day
  const selectedDateStr = selectedDay
    ? `${DAYS_SHORT[(new Date(year, month, selectedDay).getDay() + 6) % 7]}, ${selectedDay} ${MONTHS_LONG[month].slice(0,3)} ${year}`
    : null;

  const demoEvents = selectedDay === (today.getFullYear() === year && today.getMonth() === month ? today.getDate() : -1)
    ? [{ id: 1, profile: PROFILES[0], label: 'EXPENSE // FAMILY DATA', title: 'TEST (EXPENSE)', amount: 'R555.00' }]
    : [];

  return (
    <div className="page-outer">
      <div className="top-bar">
        <span className="top-eyebrow">
          <span style={{ color: '#e91e8c' }}>§ VECTRA ARCH</span>
          {' · LEGACY · CALENDAR'}
        </span>
      </div>

      <div className="page-scroll">
        <div className="page-inner">

          {/* Page header */}
          <div className="page-head">
            <div className="page-title">CALENDAR</div>
            <div className="page-sub">EVENTS · DATA · SCHEDULING INTERFACE</div>
          </div>

          {/* User chips */}
          <div className="user-row">
            {PROFILES.map(p => {
              const on = activeProfiles.has(p.id);
              return (
                <button
                  key={p.id}
                  className="user-chip"
                  onClick={() => onToggleProfile(p.id)}
                  style={{
                    borderColor: on ? p.color : 'rgba(255,255,255,0.12)',
                    background: on ? `${p.color}18` : 'var(--bg3)',
                    opacity: on ? 1 : 0.5,
                  }}
                >
                  <AvatarCircle color={p.color} initial={p.short[0]} img={p.img} size={28}/>
                  <span className="user-chip-name" style={{ color: on ? p.color : 'var(--text3)' }}>
                    {p.short}
                  </span>
                  <span style={{ fontSize: 9, color: on ? p.color : 'var(--text3)' }}>{on ? '●' : '○'}</span>
                </button>
              );
            })}
          </div>

          {/* Month navigator */}
          <div className="cal-nav">
            <button className="cal-nav-btn" onClick={prevMonth}>‹</button>
            <div className="cal-nav-month">{MONTHS_LONG[month]} {year}</div>
            <button className="cal-today-btn" onClick={goToday}>TODAY</button>
            <button className="cal-nav-btn" onClick={nextMonth}>›</button>
          </div>

          {/* Search */}
          <div className="search-bar">
            <SearchIcon/>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search events..."
            />
            {search && (
              <button onClick={() => setSearch('')} style={{ color: 'var(--text3)', fontSize: 14 }}>×</button>
            )}
          </div>

          {/* Calendar grid */}
          <div className="cal-grid">
            {DAYS_SHORT.map(d => <div key={d} className="cal-dow">{d}</div>)}

            {/* Leading empty cells */}
            {Array.from({ length: firstDow }).map((_, i) => (
              <div key={`e${i}`} className="cal-day other-month">
                <div className="cal-day-num" style={{ color: 'var(--text3)' }} />
              </div>
            ))}

            {/* Day cells */}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1;
              const isToday = year === today.getFullYear() && month === today.getMonth() && day === today.getDate();
              const isSelected = day === selectedDay;
              const dots = dotMap[day]?.filter(c => {
                const profId = PROFILES.find(p => p.color === c)?.id;
                return profId ? activeProfiles.has(profId) : false;
              }) ?? [];

              return (
                <div
                  key={day}
                  className={`cal-day${isToday ? ' today' : ''}${isSelected && !isToday ? ' selected' : ''}`}
                  onClick={() => setSelectedDay(day)}
                >
                  <div className="cal-day-num">{day}</div>
                  {dots.length > 0 && (
                    <div className="cal-day-dots">
                      {dots.map((c, idx) => (
                        <div key={idx} className="cal-dot" style={{ background: c }}/>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Legend */}
          <div className="cal-legend">
            {PROFILES.map(p => (
              <div key={p.id} className="cal-legend-item">
                <div className="cal-legend-dot" style={{ background: p.color }}/>
                {p.short}
              </div>
            ))}
          </div>

          {/* Selected day events */}
          {selectedDateStr && (
            <>
              <div className="divider"/>
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 9, color: 'var(--text3)', letterSpacing: '0.16em', textTransform: 'uppercase', margin: '12px 0 10px' }}>
                {selectedDateStr}
              </div>

              {demoEvents.length > 0 ? demoEvents.map(ev => (
                <div
                  key={ev.id}
                  className="cal-event-card"
                  style={{ borderLeftColor: ev.profile.color }}
                >
                  <AvatarCircle color={ev.profile.color} initial={ev.profile.short[0]} img={ev.profile.img} size={36}/>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 9, color: ev.profile.color, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 3 }}>
                      {ev.label}
                    </div>
                    <div className="cal-event-title">{ev.title}</div>
                  </div>
                  <div style={{
                    fontFamily: "'DM Mono', monospace", fontSize: 12, fontWeight: 500,
                    color: ev.profile.color, background: `${ev.profile.color}18`,
                    border: `1px solid ${ev.profile.color}44`,
                    padding: '6px 10px', borderRadius: 4, flexShrink: 0,
                  }}>
                    {ev.amount}
                  </div>
                </div>
              )) : (
                <div className="no-events">
                  <div className="no-events-text">No events for this day</div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* FAB */}
      <button className="fab">
        <PlusIcon/> ADD EVENT
      </button>
    </div>
  );
}

// ── Placeholder for other tabs ──
function PlaceholderPage({ tab }: { tab: typeof TABS[number] }) {
  const Icon = tab.icon;
  return (
    <div className="page-outer">
      <div className="top-bar">
        <span className="top-eyebrow">
          <span style={{ color: tab.color }}>§ VECTRA ARCH</span>
          {` · LEGACY · ${tab.id.toUpperCase()}`}
        </span>
      </div>
      <div className="page-scroll">
        <div className="page-inner">
          <div className="page-head">
            <div className="page-title">{tab.id.toUpperCase()}</div>
            <div className="page-sub">COMING SOON</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 60, gap: 16 }}>
            <Icon size={48} color={tab.color}/>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, letterSpacing: '0.2em', color: 'var(--text3)', textTransform: 'uppercase' }}>
              Module under construction
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Root App ──
export default function App() {
  const [activeTab, setActiveTab] = useState('calendar');
  const [activeProfiles, setActiveProfiles] = useState(new Set(PROFILES.map(p => p.id)));

  const toggleProfile = (id: string) => {
    setActiveProfiles(prev => {
      const next = new Set(prev);
      if (next.has(id)) { if (next.size > 1) next.delete(id); }
      else next.add(id);
      return next;
    });
  };

  const currentTab = TABS.find(t => t.id === activeTab) ?? TABS[1];

  return (
    <div className="app-shell">
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {activeTab === 'calendar'
          ? <CalendarPage activeProfiles={activeProfiles} onToggleProfile={toggleProfile}/>
          : <PlaceholderPage tab={currentTab}/>
        }
      </div>

      {/* Bottom tab bar */}
      <nav className="bottom-tabs">
        {TABS.map(tab => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              className={`tab-btn${isActive ? ' active' : ''}`}
              style={{ '--tab-color': tab.color } as React.CSSProperties}
              onClick={() => setActiveTab(tab.id)}
            >
              <Icon size={20} color={isActive ? tab.color : 'var(--text3)'}/>
              <span className="tab-label">{tab.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
