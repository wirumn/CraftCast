using System;
using System.Reflection;

namespace Scratch;

class Program
{
    static void Main()
    {
        var asm = Assembly.LoadFile(@"C:\Users\wirum\AppData\Roaming\XIVLauncher\addon\Hooks\dev\FFXIVClientStructs.dll");
        
        foreach (var type in asm.GetExportedTypes())
        {
            if (type.Name == "CraftEventHandler")
            {
                Console.WriteLine("CraftEventHandler fields:");
                foreach (var field in type.GetFields()) Console.WriteLine("  " + field.Name + " (" + field.FieldType.Name + ")");
                Console.WriteLine("CraftEventHandler properties:");
                foreach (var prop in type.GetProperties()) Console.WriteLine("  " + prop.Name + " (" + prop.PropertyType.Name + ")");
            }
            if (type.Name == "PlayerState")
            {
                Console.WriteLine("PlayerState fields:");
                foreach (var field in type.GetFields()) Console.WriteLine("  " + field.Name + " (" + field.FieldType.Name + ")");
                Console.WriteLine("PlayerState properties:");
                foreach (var prop in type.GetProperties()) Console.WriteLine("  " + prop.Name + " (" + prop.PropertyType.Name + ")");
            }
        }
    }
}
