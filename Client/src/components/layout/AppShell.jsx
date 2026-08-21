function AppShell({ children }) {
  return (
    <div className="relative min-h-screen overflow-hidden bg-[#F8F5E8] text-[#171717]">
      <div className="relative z-10 min-h-screen">{children}</div>
    </div>
  );
}

export default AppShell;