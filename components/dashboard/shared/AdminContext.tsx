"use client";
// Who is signed in, for parts deep in the page that offer admin-only actions (the clip
// panel's program picker) without passing it through every section.
import { createContext, useContext } from "react";

export const AdminContext = createContext<{ isAdmin: boolean; email: string }>({ isAdmin: false, email: "" });

export const useAdmin = () => useContext(AdminContext);
