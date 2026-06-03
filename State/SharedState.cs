namespace CraftCast.State;

/// <summary>
/// Single point of contact between the network threads and the ImGui render thread.
/// All access is lock-guarded; the render loop only ever reads an immutable snapshot.
/// </summary>
public sealed class SharedState
{
    private readonly object _gate = new();
    private string _condition = "idle";
    private int    _step;
    private string _lastAction = "—";

    public (string Condition, int Step, string LastAction) Snapshot()
    {
        lock (_gate) return (_condition, _step, _lastAction);
    }

    public void SetState(string condition, int step)
    {
        lock (_gate) { _condition = condition; _step = step; }
    }

    public void SetLastAction(string action)
    {
        lock (_gate) _lastAction = action;
    }
}
