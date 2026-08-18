import { ReactNode } from "react";

type TabsProps = {
  tabs: {
    id: string;
    label: string;
    content: ReactNode;
  }[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
};

export function Tabs({ tabs, activeTab, onTabChange }: TabsProps) {
  const activeTabContent = tabs.find((tab) => tab.id === activeTab)?.content;

  return (
    <div className="bg-surface rounded-lg border border-border shadow-soft overflow-hidden">
      <div className="border-b border-border">
        <div className="flex">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={`px-6 py-3 text-sm font-medium transition-colors border-b-2 ${
                activeTab === tab.id
                  ? "border-accent text-fg-accent"
                  : "border-transparent text-fg-secondary hover:text-fg hover:border-surface-tertiary"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>
      <div>{activeTabContent}</div>
    </div>
  );
}
