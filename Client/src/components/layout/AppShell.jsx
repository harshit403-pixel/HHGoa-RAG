function AppShell({ children }) {
  return (
    <div className="relative min-h-screen overflow-hidden bg-[#05050a] text-white">
      <div className="relative z-10 min-h-screen">{children}</div>
    </div>
  );
}

export default AppShell;